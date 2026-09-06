import { Prisma } from "@prisma/client";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { existsSync } from "node:fs";
import type { Config } from "../core/config-schema.ts";
import type { SettingsService } from "../core/settings-service.ts";
import { parseRuntimeSettingsPatch, runtimeSettingsView } from "../core/runtime-settings.ts";
import { CodexCatalogValidationError, generationOptions } from "../core/codex-catalog.ts";
import { prisma } from "../core/db.ts";
import { buildHealthServices } from "./health.ts";
import { logger } from "../core/logger.ts";
import { redactSecrets } from "../core/secrets.ts";
import { checkProviderAuthentication, validateStartup } from "../core/startup.ts";
import type { EventService } from "../events/service.ts";
import { isOpenPullRequest, type GitHubClient } from "../github/client.ts";
import { configuredAgent } from "../providers/index.ts";
import type { ProviderUsageCapability, ProviderUsageSnapshot } from "../providers/types.ts";
import { createSupportIssue } from "../support-issues/service.ts";
import { replacePullRequestLabels, replaceWorkerLabels } from "../github/labels.ts";
import { githubGitEnvironment } from "../github/git-auth.ts";
import { removeJobWorktree, repositoryPath } from "../git/repositories.ts";
import { dashboardExceptionRepository } from "../repositories/dashboard-exceptions.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { repositoryRepository } from "../repositories/repositories.ts";
import { reviewRepository } from "../repositories/reviews.ts";
import type { JobQueue } from "../queue/service.ts";
import { cleanupCancelledWorktree } from "../worktrees/recovery.ts";

type Scanner = { run(source: "SCHEDULED" | "MANUAL"): Promise<{ id: string; status: string }> };
type ApiGitHub = Pick<GitHubClient,
  "getIssue" | "setIssueLabels" | "addIssueComment" | "getPullRequest" | "getPullRequestLabels" | "setPullRequestLabels" | "createIssue" | "findIssueByMarker">;
type Scheduler = { restart(): void };
type Startup = Awaited<ReturnType<typeof validateStartup>>;

type Dependencies = {
  config: Config;
  scanner: Scanner;
  github: ApiGitHub;
  events: EventService;
  startup: Startup;
  queue: Pick<JobQueue, "health" | "remove" | "enqueue">;
  removeWorktree?: typeof removeJobWorktree;
  settings: SettingsService;
  scheduler: Scheduler;
  providerUsage?: ProviderUsageCapability;
};

function configuredAgentProfiles(config: Config) {
  const coding = configuredAgent(config, "coding");
  const review = configuredAgent(config, "review");
  return {
    coding: { model: coding.model, reasoningEffort: coding.reasoningEffort ?? null },
    review: { model: review.model, reasoningEffort: review.reasoningEffort ?? null },
  };
}

const jobQuery = z.object({
  status: z.enum(["QUEUED", "RUNNING", "WAITING_FOR_QUOTA", "COMPLETED", "FAILED", "BLOCKED", "DECOMPOSED", "CANCELLED", "STALE"]).optional(),
  jobType: z.enum(["IMPLEMENTATION", "FIX", "REVIEW", "DECOMPOSITION"]).optional(),
  subjectType: z.enum(["ISSUE", "PULL_REQUEST"]).optional(),
  provider: z.enum(["CODEX", "OPENCODE"]).optional(),
  repositoryId: z.string().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});


const jobSummaryFields = {
  id: true,
  jobType: true,
  subjectType: true,
  issueNumber: true,
  issueTitle: true,
  issueUrl: true,
  status: true,
  completedAt: true,
  durationMs: true,
  activeDurationMs: true,
  quotaWaitDurationMs: true,
  quotaWaitStartedAt: true,
  quotaResetAt: true,
  quotaWindow: true,
  quotaUsedPercent: true,
  quotaMessage: true,
  branchName: true,
  baselineCommit: true,
  pullRequestNumber: true,
  pullRequestUrl: true,
  headSha: true,
  trigger: true,
  provider: true,
  model: true,
  reasoningEffort: true,
  totalTokens: true,
  startedAt: true,
  activeStartedAt: true,
  attempts: true,
  sessionId: true,
  errorMessage: true,
  updatedAt: true,
  createdAt: true,
};

const jobSummarySelect = {
  ...jobSummaryFields,
  repository: { select: { fullName: true } },
  review: { select: { status: true } },
} satisfies Prisma.JobSelect;

const repositoryJobSummarySelect = {
  ...jobSummaryFields,
  review: { select: { status: true } },
} satisfies Prisma.JobSelect;
type StoredTokenCount = bigint | number | null | undefined;
type StoredTokenUsage = {
  inputTokens: StoredTokenCount;
  cachedInputTokens: StoredTokenCount;
  outputTokens: StoredTokenCount;
  reasoningOutputTokens: StoredTokenCount;
  totalTokens: StoredTokenCount;
};

const MAX_SAFE_TOKEN_COUNT = BigInt(Number.MAX_SAFE_INTEGER);

function serializeTokenCount(value: StoredTokenCount) {
  if (value == null) return null;
  const count = typeof value === "bigint"
    ? value
    : Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (count === null || count < BigInt(0)) return null;
  return count <= MAX_SAFE_TOKEN_COUNT ? Number(count) : count.toString();
}

function serializeTokenUsage(job: StoredTokenUsage) {
  return {
    inputTokens: serializeTokenCount(job.inputTokens),
    cachedInputTokens: serializeTokenCount(job.cachedInputTokens),
    outputTokens: serializeTokenCount(job.outputTokens),
    reasoningOutputTokens: serializeTokenCount(job.reasoningOutputTokens),
    totalTokens: serializeTokenCount(job.totalTokens),
  };
}

function serializeJobSummary<T extends { totalTokens: StoredTokenCount }>(job: T) {
  return { ...job, totalTokens: serializeTokenCount(job.totalTokens) };
}

export function createApp({
  config,
  scanner,
  github,
  events,
  startup,
  queue,
  removeWorktree = removeJobWorktree,
  settings,
  scheduler,
  providerUsage,
}: Dependencies) {
  const app = new Hono().basePath("/api");
  app.use("*", requestId(), secureHeaders(), cors({
    origin: config.FRONTEND_URL,
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }));
  app.onError((error, context) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return context.json({ error: "Not found" }, 404);
    }
    logger.error("Unhandled request error", {
      requestId: context.get("requestId"),
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
    return context.json({ error: "Internal server error" }, 500);
  });
  app.notFound((context) => context.json({ error: "Not found" }, 404));

  return app
    .get("/health", async (context) => {
      const [databaseOk, queueOk, worker, api] = await Promise.all([
        prisma.$queryRaw`SELECT 1`.then(() => true, () => false),
        queue.health().then(() => true, () => false),
        prisma.serviceHeartbeat.findFirst({
          where: { environment: config.APP_ENV, serviceName: "worker" },
          orderBy: { lastSeenAt: "desc" },
        }).catch(() => null),
        prisma.serviceHeartbeat.findFirst({
          where: { environment: config.APP_ENV, serviceName: "api" },
          orderBy: { lastSeenAt: "desc" },
        }).catch(() => null),
      ]);
      return context.json({
        status: "ok",
        environment: config.APP_ENV,
        provider: config.AGENT_PROVIDER,
        services: buildHealthServices({
          api,
          worker,
          databaseOk,
          queueOk,
          staleThresholdMs: config.STALE_JOB_THRESHOLD_MS,
        }),
      });
    })
    .get("/status", async (context) => {
      const [lastNotification, providerAuth] = await Promise.all([
        config.TELEGRAM_ENABLED ? prisma.jobEvent.findFirst({
          where: { OR: [{ notifiedAt: { not: null } }, { notificationError: { not: null } }] },
          orderBy: { createdAt: "desc" },
          select: { notifiedAt: true },
        }) : null,
        checkProviderAuthentication(config.AGENT_PROVIDER),
      ]);
      const usage = await readProviderUsage(config.AGENT_PROVIDER, providerAuth.status, providerUsage);
      return context.json({
        ...startup,
        providerAuth,
        providerUsage: usage,
        schedule: { cron: config.SCHEDULE_CRON, timezone: config.SCHEDULE_TIMEZONE },
        provider: config.AGENT_PROVIDER,
        agentProfiles: configuredAgentProfiles(config),
        maxParallelJobs: config.MAX_PARALLEL_JOBS,
        telegram: {
          configured: config.TELEGRAM_ENABLED,
          operational: Boolean(lastNotification?.notifiedAt),
        },
        repositories: config.githubRepositories,
        requiredBranch: "develop",
      });
    })
    .get("/codex/generation-options", async (context) => context.json(await generationOptions()))
    .get("/settings", (context) => context.json(settings.view()))
    .patch("/settings", async (context) => {
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json({ error: "Invalid JSON body" }, 400);
      }
      try {
        const updated = await settings.update(parseRuntimeSettingsPatch(body));
        scheduler.restart();
        return context.json(runtimeSettingsView(updated));
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof CodexCatalogValidationError) {
          return context.json({ error: "Invalid settings" }, 400);
        }
        throw error;
      }
    })
    .get("/dashboard", async (context) => {
      const acknowledgement = await dashboardExceptionRepository.findAcknowledgement(config.APP_ENV);
      const exceptionWhere: Prisma.JobWhereInput = acknowledgement
        ? {
            OR: [
              { completedAt: { gt: acknowledgement.acknowledgedAt } },
              { completedAt: null, updatedAt: { gt: acknowledgement.acknowledgedAt } },
            ],
          }
        : {};
      const [statusCounts, repositories, activeJobs, recentJobs, exceptionJobs, scans, heartbeats] = await Promise.all([
        prisma.job.groupBy({ where: { environment: config.APP_ENV }, by: ["status"], _count: true }),
        prisma.repository.findMany({ orderBy: { fullName: "asc" } }),
        prisma.job.findMany({
          where: { environment: config.APP_ENV, status: { in: ["RUNNING", "WAITING_FOR_QUOTA"] } },
          orderBy: { startedAt: "asc" },
          select: jobSummarySelect,
        }),
        prisma.job.findMany({
          where: { environment: config.APP_ENV },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: jobSummarySelect,
        }),
        prisma.job.findMany({
          where: { environment: config.APP_ENV, status: { in: [...dashboardExceptionRepository.exceptionStatuses] }, ...exceptionWhere },
          orderBy: { completedAt: "desc" },
          take: 12,
          select: jobSummarySelect,
        }),
        prisma.scanRun.findMany({
          where: { environment: config.APP_ENV }, orderBy: { startedAt: "desc" }, take: 10,
        }),
        prisma.serviceHeartbeat.findMany({
          where: { environment: config.APP_ENV }, orderBy: { lastSeenAt: "desc" },
        }),
      ]);
      return context.json({
        jobs: Object.fromEntries(statusCounts.map((row) => [row.status, row._count])),
        configuration: {
          provider: config.AGENT_PROVIDER,
          agentProfiles: configuredAgentProfiles(config),
          telegramConfigured: config.TELEGRAM_ENABLED,
        },
        repositories,
        activeJobs: activeJobs.map(serializeJobSummary),
        recentJobs: recentJobs.map(serializeJobSummary),
        exceptionJobs: exceptionJobs.map(serializeJobSummary),
        scans,
        heartbeats,
      });
    })
    .post("/dashboard/exceptions/clear", async (context) => {
      const acknowledgement = await dashboardExceptionRepository.acknowledge(config.APP_ENV);
      return context.json({ acknowledgedAt: acknowledgement.acknowledgedAt, exceptionJobs: [] });
    })
    .get("/jobs", async (context) => {
      const parsed = jobQuery.safeParse(context.req.query());
      if (!parsed.success) return context.json({ error: "Invalid job filters" }, 400);
      const { page, pageSize, q, ...filters } = parsed.data;
      const issueNumber = q && /^\d+$/.test(q) ? Number(q) : undefined;
      const where: Prisma.JobWhereInput = {
        environment: config.APP_ENV,
        ...filters,
        ...(q ? { OR: [
          { issueTitle: { contains: q, mode: "insensitive" } },
          { repository: { fullName: { contains: q, mode: "insensitive" } } },
          ...(issueNumber ? [{ issueNumber }, { pullRequestNumber: issueNumber }] : []),
        ] } : {}),
      };
      const [items, total] = await Promise.all([
        prisma.job.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: jobSummarySelect,
        }),
        prisma.job.count({ where }),
      ]);
      return context.json({ items: items.map(serializeJobSummary), total, page, pageSize });
    })
    .get("/jobs/:id", async (context) => {
      const job = await prisma.job.findFirst({
        where: { id: context.req.param("id"), environment: config.APP_ENV },
        include: {
          repository: true,
          review: true,
          pullRequest: true,
          events: { orderBy: { createdAt: "asc" } },
        },
      });
      if (!job) return context.json({ error: "Not found" }, 404);
      const {
        claimToken: _claimToken,
        cleanupToken: _cleanupToken,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens,
        review,
        ...publicJob
      } = job;
      const publicReview = review ? (({ claimToken: _reviewClaimToken, ...safeReview }) => safeReview)(review) : null;
      return context.json({
        ...publicJob,
        review: publicReview,
        pullRequestUrl: canonicalPullRequestUrl(job.repository, job.pullRequestNumber),
        usage: serializeTokenUsage({ inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens }),
      });
    })
    .post("/jobs/:id/support-issue", async (context) => {
      const result = await createSupportIssue({ config, github, jobId: context.req.param("id") });
      if (result.kind === "missing") return context.json({ error: "Not found" }, 404);
      if (result.kind === "not_failed") return context.json({ error: "Only failed jobs can create support issues" }, 409);
      if (result.kind === "existing") {
        return context.json({
          status: "existing" as const,
          issueNumber: result.issue.number,
          issueUrl: result.issue.url,
        });
      }
      if (result.kind === "in_progress") return context.json({ error: "Support issue creation is already in progress" }, 409);
      if (result.kind === "failed") {
        const message = result.reason === "persistence"
          ? "Support issue was created but could not be recorded"
          : redactSecrets(result.error instanceof Error ? result.error.message : String(result.error), {
            ...globalThis.process.env,
            GITHUB_TOKEN: config.GITHUB_TOKEN,
          }).slice(0, 2_000);
        return context.json({ error: result.reason === "persistence" ? message : `Could not create support issue: ${message}` }, result.reason === "persistence" ? 500 : 502);
      }
      const issue = result.issue;
      void events.record({
        type: "SUPPORT_ISSUE_CREATED",
        message: `Created support issue #${issue.number} for failed job ${context.req.param("id")}`,
        jobId: context.req.param("id"),
        repositoryId: result.repositoryId,
        metadata: { issueUrl: issue.url },
      }).catch(() => {});
      return context.json({ status: "created" as const, issueNumber: issue.number, issueUrl: issue.url }, 201);
    })
    .get("/repositories", async (context) => {
      const repositories = await prisma.repository.findMany({
        orderBy: { fullName: "asc" },
        include: {
          jobs: {
            where: { environment: config.APP_ENV },
            orderBy: { createdAt: "desc" },
            take: 5,
            select: repositoryJobSummarySelect,
          },
        },
      });
      return context.json(repositories.map((repository) => ({
        ...repository,
        jobs: repository.jobs.map(serializeJobSummary),
      })));
    })
    .delete("/repositories/:id", async (context) => {
      const id = context.req.param("id");
      const existing = await prisma.repository.findUnique({
        where: { id },
        select: { fullName: true, cloneUrl: true, localPath: true },
      });
      if (!existing) return context.json({ error: "Not found" }, 404);
      const remaining = config.githubRepositories.filter((name) => name !== existing.fullName);
      const configured = remaining.length !== config.githubRepositories.length;
      const result = await repositoryRepository.remove(id, existing.fullName, configured
        ? { environment: config.APP_ENV, value: remaining.length > 0 ? remaining.join(",") : null }
        : undefined,
      async (worktreePath) => removeWorktree({
        worktreePath,
        repositoryPath: existing.localPath ?? repositoryPath(config.DATA_DIR, existing.fullName),
        gitEnvironment: githubGitEnvironment(config.GITHUB_TOKEN, existing.cloneUrl),
      }));
      if (result?.blocked) {
        return context.json({
          error: `Cannot remove the repository while ${result.activeJobs} active job${result.activeJobs === 1 ? "" : "s"} ${result.activeJobs === 1 ? "is" : "are"} queued, waiting, or running. Cancel or finish them first.`,
        }, 409);
      }
      if (result?.cleanupRequired) {
        return context.json({ error: "Cannot remove the repository while retained job worktrees are still being cleaned up." }, 409);
      }
      if (result?.cleanupFailed) {
        return context.json({ error: "Could not clean retained job worktrees before removing the repository." }, 502);
      }
      if (configured) {
        await settings.reload();
        scheduler.restart();
      }
      await events.record({
        type: "REPOSITORY_REMOVED",
        message: `Removed ${existing.fullName} from configured repositories`,
        metadata: { repositoryId: id },
      });
      return context.json({ status: "removed" });
    })
    .post("/jobs/:id/cancel", async (context) => {
      const job = await prisma.job.findFirst({
        where: { id: context.req.param("id"), environment: config.APP_ENV }, include: { repository: true },
      });
      if (!job) return context.json({ error: "Not found" }, 404);
      if (!await jobRepository.cancel(job.id)) return context.json({ error: "Job is already terminal" }, 409);
      await queue.remove(job.id);
      const cancelled = await prisma.job.findUnique({ where: { id: job.id }, select: { worktreePath: true, workerId: true, claimToken: true } });
      if (cancelled && !cancelled.workerId && cancelled.worktreePath) {
        await cleanupCancelledWorktree(config, events, { ...job, ...cancelled }, removeWorktree);
      }
      if (job.status === "WAITING_FOR_QUOTA" && job.jobType === "REVIEW") {
        await reviewRepository.cancelForJob(job.id);
      }
      await events.record({
        type: "JOB_CANCELLED",
        message: `Cancelled ${job.jobType} job for ${job.repository.fullName}#${job.issueNumber}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, pullRequestNumber: job.pullRequestNumber ?? undefined },
      });
      if (job.subjectType === "PULL_REQUEST" && job.pullRequestNumber) {
        try {
          await github.addIssueComment(
            job.repository.fullName,
            job.pullRequestNumber,
            "Worker job cancelled by an operator. The next scan will reschedule the work.",
          );
        } catch {
          // the event above already carries the durable evidence
        }
      } else {
        await reconcileIssue(job, [], "Worker job cancelled by an operator.");
      }
      return context.json({ status: "CANCELLED" });
    })
    .post("/jobs/:id/retry", async (context) => {
      const job = await prisma.job.findFirst({
        where: { id: context.req.param("id"), environment: config.APP_ENV }, include: { repository: true },
      });
      if (!job) return context.json({ error: "Not found" }, 404);
      if (!["FAILED", "BLOCKED", "CANCELLED", "STALE"].includes(job.status)) {
        return context.json({ error: "Only failed, blocked, cancelled, or stale jobs can be retried" }, 409);
      }
      if (job.status === "FAILED" && job.worktreePath && !existsSync(job.worktreePath)) {
        return context.json({ error: "Retained worktree is missing; retry cannot resume the job" }, 409);
      }

      let currentPullRequest;
      if (job.subjectType === "PULL_REQUEST" && job.pullRequestNumber) {
        try {
          currentPullRequest = await github.getPullRequest(job.repository.fullName, job.pullRequestNumber);
        } catch (error) {
          await events.record({
            type: "GITHUB_RECONCILIATION_REQUIRED",
            level: "ERROR",
            message: `Could not validate the pull request head for ${job.repository.fullName}#${job.pullRequestNumber}: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            metadata: { issueUrl: job.issueUrl, pullRequestNumber: job.pullRequestNumber },
          });
          return context.json({ error: "Could not validate the pull request head" }, 502);
        }
      }
      if (currentPullRequest && !isOpenPullRequest(currentPullRequest)) {
        try {
          if (!await discardNonResumableRetry(job)) {
            return context.json({ error: "Job cleanup is still in progress" }, 409);
          }
        } catch (error) {
          await events.record({
            type: "GITHUB_RECONCILIATION_REQUIRED",
            level: "ERROR",
            message: `Could not clean up the non-resumable pull request retry for ${job.repository.fullName}#${job.pullRequestNumber}: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            metadata: { issueUrl: job.issueUrl, pullRequestNumber: job.pullRequestNumber },
          });
          return context.json({ error: "Could not clean up the non-resumable pull request retry" }, 502);
        }
        return context.json({ error: "Pull request is closed or merged; retry was not queued" }, 409);
      }
      if (currentPullRequest && job.headSha && currentPullRequest.headSha !== job.headSha) {
        const trigger = job.jobType === "REVIEW" ? config.PR_REVIEW_REQUESTED_LABEL : config.PR_FIX_REQUESTED_LABEL;
        try {
          if (!await discardNonResumableRetry(job)) {
            return context.json({ error: "Job cleanup is still in progress" }, 409);
          }
        } catch (error) {
          await events.record({
            type: "GITHUB_RECONCILIATION_REQUIRED",
            level: "ERROR",
            message: `Could not clean up the obsolete pull request retry for ${job.repository.fullName}#${job.pullRequestNumber}: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            metadata: { issueUrl: job.issueUrl, pullRequestNumber: job.pullRequestNumber, headSha: currentPullRequest.headSha },
          });
          return context.json({ error: "Could not clean up the obsolete pull request retry" }, 502);
        }
        try {
          const labels = await github.getPullRequestLabels(job.repository.fullName, job.pullRequestNumber!);
          await github.setPullRequestLabels(
            job.repository.fullName,
            job.pullRequestNumber!,
            replacePullRequestLabels(labels, config, [trigger]),
          );
          await github.addIssueComment(
            job.repository.fullName,
            job.pullRequestNumber!,
            `Retry was not queued because the pull request advanced from ${job.headSha} to ${currentPullRequest.headSha}. The ${trigger} trigger was restored for the current head.`,
          );
        } catch (error) {
          await events.record({
            type: "GITHUB_RECONCILIATION_REQUIRED",
            level: "ERROR",
            message: `Could not restore the pull request retry trigger for ${job.repository.fullName}#${job.pullRequestNumber}: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            metadata: { issueUrl: job.issueUrl, pullRequestNumber: job.pullRequestNumber, headSha: currentPullRequest.headSha },
          });
          return context.json({ error: "Could not restore the pull request retry trigger" }, 502);
        }
        return context.json({ error: "Pull request head changed; retry was not queued" }, 409);
      }

      let requeued;
      try {
        requeued = await jobRepository.requeueForRetry(job.id, config.APP_ENV);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return context.json({ error: "A job for this issue or pull request is already active" }, 409);
        }
        throw error;
      }
      if (!requeued) {
        const current = await prisma.job.findFirst({
          where: { id: job.id, environment: config.APP_ENV },
          select: { status: true, workerId: true, cleanupToken: true, worktreePath: true },
        });
        const cleanupPending = current?.workerId !== null || current?.cleanupToken !== null
          || (current?.status !== "FAILED" && current?.worktreePath !== null);
        return current
          ? context.json({ error: current.status === "QUEUED" || current.status === "RUNNING" ? "Retry is already in progress" : cleanupPending ? "Job cleanup is still in progress" : "Job is no longer retryable" }, 409)
          : context.json({ error: "Not found" }, 404);
      }
      const sessionResumed = Boolean(requeued.sessionId);
      await events.record({
        type: "JOB_RESUME_REQUESTED",
        message: sessionResumed
          ? `Retry requested for ${job.jobType} job on ${job.repository.fullName}#${job.issueNumber}; persisted session ${requeued.sessionId} will be resumed`
          : `Retry requested for ${job.jobType} job on ${job.repository.fullName}#${job.issueNumber}; no provider session was persisted`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        metadata: {
          issueUrl: job.issueUrl,
          pullRequestNumber: job.pullRequestNumber ?? undefined,
          attempt: requeued.attempts + 1,
          sessionId: requeued.sessionId ?? undefined,
          sessionResumed,
        },
      });
      const retryComment = sessionResumed
        ? `Worker retry queued. The existing provider session ${requeued.sessionId} will resume in the retained workspace.`
        : "Worker retry queued. No provider session was persisted, so execution will restart in the retained workspace.";
      if (job.subjectType === "PULL_REQUEST" && job.pullRequestNumber) {
        try {
          const labels = await github.getPullRequestLabels(job.repository.fullName, job.pullRequestNumber);
          await github.setPullRequestLabels(
            job.repository.fullName,
            job.pullRequestNumber,
            replacePullRequestLabels(labels, config, []),
          );
          await github.addIssueComment(
            job.repository.fullName,
            job.pullRequestNumber,
            retryComment,
          );
        } catch (error) {
          await events.record({
            type: "GITHUB_RECONCILIATION_REQUIRED",
            level: "ERROR",
            message: `Could not reconcile the pull request retry for ${job.repository.fullName}#${job.pullRequestNumber}: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            metadata: { issueUrl: job.issueUrl, pullRequestNumber: job.pullRequestNumber },
          });
        }
        await reconcileIssue(job, [config.ISSUE_WORKING_LABEL], retryComment);
      } else {
        await reconcileIssue(
          job,
          [config.ISSUE_WORKING_LABEL],
          retryComment,
        );
      }
      try {
        await queue.enqueue(job.id);
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
        if (await jobRepository.failQueued(job.id, message, true)) {
          await events.record({
            type: "JOB_FAILED",
            level: "ERROR",
            message: `Could not enqueue retry for ${job.repository.fullName}#${job.issueNumber}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            metadata: { issueUrl: job.issueUrl, pullRequestNumber: job.pullRequestNumber ?? undefined },
          });
        }
        return context.json({ error: "Could not enqueue the job retry" }, 502);
      }
      return context.json({ jobId: job.id, status: "QUEUED", sessionResumed }, 202);
    })
    .get("/scans", async (context) => context.json(await prisma.scanRun.findMany({
      where: { environment: config.APP_ENV }, orderBy: { startedAt: "desc" }, take: 100,
    })))
    .post("/scans/run", async (context) => context.json(await scanner.run("MANUAL"), 202))
    .get("/events", async (context) => {
      const after = context.req.query("after");
      const date = after ? new Date(after) : undefined;
      if (date && Number.isNaN(date.getTime())) return context.json({ error: "Invalid after timestamp" }, 400);
      return context.json(await prisma.jobEvent.findMany({
        where: { createdAt: date ? { gt: date } : undefined },
        orderBy: { createdAt: "desc" },
        take: 200,
      }));
    })
    .post("/notifications/test", async (context) => {
      if (!config.TELEGRAM_ENABLED) return context.json({ error: "Telegram is disabled" }, 409);
      const event = await events.record({ type: "TELEGRAM_TEST", message: "Swarmloom test notification" });
      return event.notificationError
        ? context.json({ error: event.notificationError }, 502)
        : context.json({ status: "sent" });
    });

  async function reconcileIssue(
    job: { issueNumber: number; issueUrl: string; repository: { fullName: string }; id: string; repositoryId: string },
    labels: string[],
    comment: string,
  ) {
    try {
      const issue = await github.getIssue(job.repository.fullName, job.issueNumber);
      await github.setIssueLabels(
        job.repository.fullName,
        job.issueNumber,
        replaceWorkerLabels(issue.labels, config, labels),
      );
      await github.addIssueComment(job.repository.fullName, job.issueNumber, comment);
      return true;
    } catch (error) {
      await events.record({
        type: "GITHUB_RECONCILIATION_REQUIRED",
        level: "ERROR",
        message: `Could not update ${job.repository.fullName}#${job.issueNumber}: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        metadata: { issueUrl: job.issueUrl },
      });
      return false;
    }
  }

  async function discardNonResumableRetry(job: {
    id: string;
    claimToken: string | null;
    worktreePath: string | null;
    repositoryId: string;
    repository: { localPath: string | null; fullName: string; cloneUrl: string };
  }) {
    const cleanup = job.worktreePath
      ? await jobRepository.claimWorktreeCleanup(job.id, null, job.claimToken, job.worktreePath)
      : null;
    if (job.worktreePath && !cleanup) return false;
    if (cleanup) {
      await removeWorktree({
        worktreePath: cleanup.path,
        repositoryPath: job.repository.localPath ?? repositoryPath(config.DATA_DIR, job.repository.fullName),
        gitEnvironment: githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl),
      });
      if (!await jobRepository.clearWorktree(job.id, job.claimToken, cleanup.cleanupToken)) return false;
    }
    return jobRepository.discardTerminalJob(job.id, job.claimToken);
  }
}

async function readProviderUsage(
  provider: Config["AGENT_PROVIDER"],
  authentication: "authenticated" | "required",
  capability?: ProviderUsageCapability,
): Promise<ProviderUsageSnapshot> {
  if (provider !== "codex") {
    return {
      status: "unsupported",
      availability: "unknown",
      spendControlReached: null,
      rateLimitReachedType: null,
      observedAt: null,
      windows: [],
      message: "Quota telemetry is not supported for this provider",
    };
  }
  if (authentication !== "authenticated") {
    return {
      status: "unavailable",
      availability: "unknown",
      spendControlReached: null,
      rateLimitReachedType: null,
      observedAt: null,
      windows: [],
      message: "Codex authentication is required to read quota",
    };
  }
  if (!capability) {
    return {
      status: "unavailable",
      availability: "unknown",
      spendControlReached: null,
      rateLimitReachedType: null,
      observedAt: null,
      windows: [],
      message: "Codex quota telemetry is not configured",
    };
  }
  try {
    return await capability.readAccountUsage();
  } catch {
    return {
      status: "unavailable",
      availability: "unknown",
      spendControlReached: null,
      rateLimitReachedType: null,
      observedAt: null,
      windows: [],
      message: "Codex quota telemetry is unavailable",
    };
  }
}

function canonicalPullRequestUrl(
  repository: { cloneUrl: string; fullName: string },
  pullRequestNumber: number | null,
) {
  if (pullRequestNumber == null) return null;
  const url = new URL(repository.cloneUrl);
  url.pathname = `/${repository.fullName}/pull/${pullRequestNumber}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export type AppType = ReturnType<typeof createApp>;

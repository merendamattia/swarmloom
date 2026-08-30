import { Prisma } from "@prisma/client";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import type { Config } from "../core/config-schema.ts";
import type { SettingsService } from "../core/settings-service.ts";
import { parseRuntimeSettingsPatch, runtimeSettingsView } from "../core/runtime-settings.ts";
import { prisma } from "../core/db.ts";
import { buildHealthServices } from "./health.ts";
import { logger } from "../core/logger.ts";
import { redactSecrets } from "../core/secrets.ts";
import { checkProviderAuthentication, validateStartup } from "../core/startup.ts";
import type { EventService } from "../events/service.ts";
import type { GitHubClient } from "../github/client.ts";
import { configuredAgent } from "../providers/index.ts";
import type { ProviderUsageCapability, ProviderUsageSnapshot } from "../providers/types.ts";
import { createSupportIssue } from "../support-issues/service.ts";
import { replacePullRequestLabels, replaceWorkerLabels } from "../github/labels.ts";
import { dashboardExceptionRepository } from "../repositories/dashboard-exceptions.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { repositoryRepository } from "../repositories/repositories.ts";
import type { JobQueue } from "../queue/service.ts";

type Scanner = { run(source: "SCHEDULED" | "MANUAL"): Promise<{ id: string; status: string }> };
type ApiGitHub = Pick<GitHubClient,
  "getIssue" | "setIssueLabels" | "addIssueComment" | "getPullRequestLabels" | "setPullRequestLabels" | "createIssue" | "findIssueByMarker">;
type Scheduler = { restart(): void };
type Startup = Awaited<ReturnType<typeof validateStartup>>;

type Dependencies = {
  config: Config;
  scanner: Scanner;
  github: ApiGitHub;
  events: EventService;
  startup: Startup;
  queue: Pick<JobQueue, "health" | "remove">;
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
  status: z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "BLOCKED", "DECOMPOSED", "CANCELLED", "STALE"]).optional(),
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
  attempts: true,
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
export function createApp({ config, scanner, github, events, startup, queue, settings, scheduler, providerUsage }: Dependencies) {
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
        if (error instanceof z.ZodError) return context.json({ error: "Invalid settings" }, 400);
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
          where: { environment: config.APP_ENV, status: "RUNNING" },
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
        activeJobs,
        recentJobs,
        exceptionJobs,
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
      return context.json({ items, total, page, pageSize });
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
      return job
        ? context.json({
          ...job,
          pullRequestUrl: canonicalPullRequestUrl(job.repository, job.pullRequestNumber),
          usage: {
            inputTokens: job.inputTokens,
            cachedInputTokens: job.cachedInputTokens,
            outputTokens: job.outputTokens,
            reasoningOutputTokens: job.reasoningOutputTokens,
            totalTokens: job.totalTokens,
          },
        })
        : context.json({ error: "Not found" }, 404);
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
    .get("/repositories", async (context) => context.json(await prisma.repository.findMany({
      orderBy: { fullName: "asc" },
      include: {
        jobs: {
          where: { environment: config.APP_ENV },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: repositoryJobSummarySelect,
        },
      },
    })))
    .delete("/repositories/:id", async (context) => {
      const id = context.req.param("id");
      const existing = await prisma.repository.findUnique({ where: { id }, select: { fullName: true } });
      if (!existing) return context.json({ error: "Not found" }, 404);
      const remaining = config.githubRepositories.filter((name) => name !== existing.fullName);
      const configured = remaining.length !== config.githubRepositories.length;
      const result = await repositoryRepository.remove(id, existing.fullName, configured
        ? { environment: config.APP_ENV, value: remaining.length > 0 ? remaining.join(",") : null }
        : undefined);
      if (result?.blocked) {
        return context.json({
          error: `Cannot remove the repository while ${result.activeJobs} active job${result.activeJobs === 1 ? "" : "s"} ${result.activeJobs === 1 ? "is" : "are"} queued or running. Cancel or finish them first.`,
        }, 409);
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
      await queue.remove(job.queueJobId);
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
      if (job.subjectType === "PULL_REQUEST" && job.pullRequestNumber) {
        try {
          const labels = await github.getPullRequestLabels(job.repository.fullName, job.pullRequestNumber);
          const nextLabels = job.jobType === "REVIEW"
            ? [config.PR_REVIEW_REQUESTED_LABEL]
            : [config.PR_FIX_REQUESTED_LABEL];
          await github.setPullRequestLabels(
            job.repository.fullName,
            job.pullRequestNumber,
            replacePullRequestLabels(labels, config, nextLabels),
          );
        } catch (error) {
          await events.record({
            type: "GITHUB_RECONCILIATION_REQUIRED",
            level: "ERROR",
            message: `Could not restore the pull request label for ${job.repository.fullName}#${job.pullRequestNumber}: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            metadata: { issueUrl: job.issueUrl, pullRequestNumber: job.pullRequestNumber },
          });
        }
      } else {
        if (!await reconcileIssue(job, [config.ISSUE_READY_LABEL],
          `Retry requested for prior worker job ${job.id}.`)) {
          return context.json({ error: "Could not restore the GitHub ready label" }, 502);
        }
      }
      await events.record({
        type: "JOB_RETRY_REQUESTED",
        message: `Retry requested for ${job.jobType} job on ${job.repository.fullName}#${job.issueNumber}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        metadata: { issueUrl: job.issueUrl, pullRequestNumber: job.pullRequestNumber ?? undefined },
      });
      const scan = await scanner.run("MANUAL");
      return context.json({ scanId: scan.id, scanStatus: scan.status }, 202);
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

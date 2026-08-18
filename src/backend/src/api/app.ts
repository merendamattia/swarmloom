import { Prisma } from "@prisma/client";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../core/config-schema.ts";
import type { SettingsService } from "../core/settings-service.ts";
import { parseRuntimeSettingsPatch, runtimeSettingsView } from "../core/runtime-settings.ts";
import { prisma } from "../core/db.ts";
import { logger } from "../core/logger.ts";
import { redactSecrets } from "../core/secrets.ts";
import { checkProviderAuthentication } from "../core/startup.ts";
import type { EventService } from "../events/service.ts";
import type { GitHubClient } from "../github/client.ts";
import { replaceWorkerLabels } from "../github/labels.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { finishScanIfComplete } from "../scans/finalize.ts";
import type { JobQueue } from "../queue/service.ts";
import { artifactDirectory } from "../runner/visual.ts";

type Scanner = { run(source: "SCHEDULED" | "MANUAL"): Promise<{ id: string; status: string }> };
type ApiGitHub = Pick<GitHubClient, "getIssue" | "setIssueLabels" | "addIssueComment">;
type Scheduler = { restart(): void };

type Dependencies = {
  config: Config;
  scanner: Scanner;
  github: ApiGitHub;
  events: EventService;
  startup: Record<string, unknown>;
  queue: Pick<JobQueue, "health" | "remove">;
  settings: SettingsService;
  scheduler: Scheduler;
};

const jobQuery = z.object({
  status: z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "BLOCKED", "DECOMPOSED", "CANCELLED", "STALE"]).optional(),
  provider: z.enum(["CODEX", "OPENCODE"]).optional(),
  repositoryId: z.string().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function createApp({ config, scanner, github, events, startup, queue, settings, scheduler }: Dependencies) {
  const app = new Hono().basePath("/api");
  app.use("*", requestId(), secureHeaders(), cors({
    origin: config.FRONTEND_URL,
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
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
      await prisma.$queryRaw`SELECT 1`;
      await queue.health();
      const worker = await prisma.serviceHeartbeat.findFirst({
        where: { environment: config.APP_ENV, serviceName: "worker" },
        orderBy: { lastSeenAt: "desc" },
      });
      return context.json({
        status: "ok",
        environment: config.APP_ENV,
        database: "ok",
        queue: "ok",
        scheduler: "running",
        provider: config.AGENT_PROVIDER,
        worker: {
          operational: Boolean(worker && worker.lastSeenAt.getTime() > Date.now() - config.STALE_JOB_THRESHOLD_MS),
          lastSeenAt: worker?.lastSeenAt ?? null,
        },
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
      return context.json({
        ...startup,
        providerAuth,
        schedule: { cron: config.SCHEDULE_CRON, timezone: config.SCHEDULE_TIMEZONE },
        provider: config.AGENT_PROVIDER,
        model: config.AGENT_PROVIDER === "codex" ? config.CODEX_MODEL : config.OPENCODE_MODEL,
        reasoningEffort: config.AGENT_PROVIDER === "codex" ? config.CODEX_REASONING_EFFORT : null,
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
      const [statusCounts, repositories, activeJobs, recentJobs, scans, heartbeats] = await Promise.all([
        prisma.job.groupBy({ where: { environment: config.APP_ENV }, by: ["status"], _count: true }),
        prisma.repository.findMany({ orderBy: { fullName: "asc" } }),
        prisma.job.findMany({
          where: { environment: config.APP_ENV, status: "RUNNING" },
          orderBy: { startedAt: "asc" },
          include: { repository: { select: { fullName: true } }, review: true },
        }),
        prisma.job.findMany({
          where: { environment: config.APP_ENV },
          orderBy: { createdAt: "desc" },
          take: 12,
          include: { repository: { select: { fullName: true } }, review: true },
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
          model: config.AGENT_PROVIDER === "codex" ? config.CODEX_MODEL : config.OPENCODE_MODEL,
          reasoningEffort: config.AGENT_PROVIDER === "codex" ? config.CODEX_REASONING_EFFORT : null,
          telegramConfigured: config.TELEGRAM_ENABLED,
        },
        repositories,
        activeJobs,
        recentJobs,
        scans,
        heartbeats,
      });
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
          ...(issueNumber ? [{ issueNumber }] : []),
        ] } : {}),
      };
      const [items, total] = await Promise.all([
        prisma.job.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { repository: { select: { fullName: true } }, review: true },
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
          events: { orderBy: { createdAt: "asc" } },
        },
      });
      return job
        ? context.json({ ...job, pullRequestUrl: canonicalPullRequestUrl(job.repository, job.pullRequestNumber) })
        : context.json({ error: "Not found" }, 404);
    })
    .get("/artifacts/:jobId/:fileName", async (context) => {
      const job = await prisma.job.findFirst({
        where: { id: context.req.param("jobId"), environment: config.APP_ENV },
        select: { id: true },
      });
      if (!job) return context.json({ error: "Not found" }, 404);
      const directory = artifactDirectory(config.DATA_DIR, job.id);
      const file = Bun.file(resolve(directory, context.req.param("fileName")));
      if (!await file.exists()) return context.json({ error: "Not found" }, 404);
      return new Response(file.stream(), {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
      });
    })
    .get("/repositories", async (context) => context.json(await prisma.repository.findMany({
      orderBy: { fullName: "asc" },
      include: {
        jobs: {
          where: { environment: config.APP_ENV },
          orderBy: { createdAt: "desc" },
          take: 5,
          include: { review: true },
        },
      },
    })))
    .post("/jobs/:id/cancel", async (context) => {
      const job = await prisma.job.findFirst({
        where: { id: context.req.param("id"), environment: config.APP_ENV }, include: { repository: true },
      });
      if (!job) return context.json({ error: "Not found" }, 404);
      if (!await jobRepository.cancel(job.id)) return context.json({ error: "Job is already terminal" }, 409);
      await queue.remove(job.queueJobId);
      await events.record({
        type: "JOB_CANCELLED",
        message: `Cancelled ${job.repository.fullName}#${job.issueNumber}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl },
      });
      await reconcileIssue(job, [], "Worker job cancelled by an operator.");
      await finishScanIfComplete(job.scanRunId, job.environment, events);
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
      if (!await reconcileIssue(job, [config.ISSUE_READY_LABEL],
        `Retry requested for prior worker job ${job.id}.`)) {
        return context.json({ error: "Could not restore the GitHub ready label" }, 502);
      }
      await events.record({
        type: "JOB_RETRY_REQUESTED",
        message: `Retry requested for ${job.repository.fullName}#${job.issueNumber}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        metadata: { issueUrl: job.issueUrl },
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

import type { ScanRun, ScanSource } from "@prisma/client";
import { prisma } from "../core/db.ts";

async function start(environment: string, source: ScanSource, repositoriesTotal: number) {
  const [scan] = await prisma.$queryRaw<ScanRun[]>`
    INSERT INTO "scan_run" (
      "id", "activeEnvironmentKey", "environment", "source", "repositoriesTotal", "updatedAt"
    ) VALUES (
      ${crypto.randomUUID()}, ${environment}, ${environment}, ${source}::"ScanSource",
      ${repositoriesTotal}, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("activeEnvironmentKey") DO NOTHING
    RETURNING *
  `;
  if (scan) return scan;
  return prisma.scanRun.create({
    data: {
      environment,
      source,
      repositoriesTotal,
      status: "SKIPPED",
      completedAt: new Date(),
      durationMs: 0,
      errorMessage: "Another scan is already active for this environment",
    },
  });
}

async function finishDiscovery(id: string, queuedCount: number) {
  return prisma.scanRun.update({
    where: { id },
    data: { queuedCount, discoveryCompletedAt: new Date() },
  });
}

async function fail(id: string, errorMessage: string) {
  const completedAt = new Date();
  const current = await prisma.scanRun.findUniqueOrThrow({ where: { id } });
  return prisma.scanRun.update({
    where: { id },
    data: {
      status: "FAILED",
      activeEnvironmentKey: null,
      errorMessage,
      completedAt,
      durationMs: completedAt.getTime() - current.startedAt.getTime(),
    },
  });
}

async function finishJobs(id: string, environment: string) {
  const [scan, statuses, queueRemaining] = await Promise.all([
    prisma.scanRun.findUnique({ where: { id } }),
    prisma.job.groupBy({ where: { scanRunId: id }, by: ["status"], _count: true }),
    prisma.job.count({ where: { environment, status: "QUEUED" } }),
  ]);
  if (!scan || scan.status !== "RUNNING" || !scan.discoveryCompletedAt) return null;
  const counts = Object.fromEntries(statuses.map((row) => [row.status, row._count]));
  if ((counts.QUEUED ?? 0) + (counts.RUNNING ?? 0) > 0) return null;
  const completedAt = new Date();
  const reviewsCount = await prisma.review.count({ where: { job: { scanRunId: id } } });
  const updated = await prisma.scanRun.updateMany({
    where: { id, status: "RUNNING" },
    data: {
      status: "COMPLETED",
      activeEnvironmentKey: null,
      completedAt,
      durationMs: completedAt.getTime() - scan.startedAt.getTime(),
      successCount: counts.COMPLETED ?? 0,
      failureCount: (counts.FAILED ?? 0) + (counts.STALE ?? 0),
      blockedCount: counts.BLOCKED ?? 0,
      decomposedCount: counts.DECOMPOSED ?? 0,
      pullRequestsCount: await prisma.job.count({
        where: { scanRunId: id, pullRequestNumber: { not: null } },
      }),
      reviewsCount,
      queueRemaining,
    },
  });
  return updated.count === 1 ? prisma.scanRun.findUnique({ where: { id } }) : null;
}

async function recoverRunning(environment: string) {
  return prisma.scanRun.updateMany({
    where: {
      environment,
      status: "RUNNING",
      jobs: { none: { status: { in: ["QUEUED", "RUNNING"] } } },
    },
    data: {
      status: "FAILED",
      activeEnvironmentKey: null,
      completedAt: new Date(),
      errorMessage: "Application restarted before the scan reached a terminal state",
    },
  });
}

export const scanRunRepository = { start, finishDiscovery, fail, finishJobs, recoverRunning };

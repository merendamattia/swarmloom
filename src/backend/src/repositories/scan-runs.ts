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
  const current = await prisma.scanRun.findUniqueOrThrow({ where: { id } });
  const completedAt = new Date();
  return prisma.scanRun.update({
    where: { id },
    data: {
      status: "COMPLETED",
      activeEnvironmentKey: null,
      queuedCount,
      discoveryCompletedAt: completedAt,
      completedAt,
      durationMs: completedAt.getTime() - current.startedAt.getTime(),
    },
  });
}

async function fail(id: string, errorMessage: string) {
  const completedAt = new Date();
  const current = await prisma.scanRun.findUniqueOrThrow({ where: { id } });
  const updated = await prisma.scanRun.updateMany({
    where: { id, status: "RUNNING" },
    data: {
      status: "FAILED",
      activeEnvironmentKey: null,
      errorMessage,
      completedAt,
      durationMs: completedAt.getTime() - current.startedAt.getTime(),
    },
  });
  return updated.count === 1 ? prisma.scanRun.findUnique({ where: { id } }) : null;
}

async function recoverRunning(environment: string) {
  const completedAt = new Date();
  await prisma.scanRun.updateMany({
    where: {
      environment,
      status: "RUNNING",
      discoveryCompletedAt: { not: null },
    },
    data: {
      status: "COMPLETED",
      activeEnvironmentKey: null,
      completedAt,
    },
  });
  return prisma.scanRun.updateMany({
    where: {
      environment,
      status: "RUNNING",
      discoveryCompletedAt: null,
    },
    data: {
      status: "FAILED",
      activeEnvironmentKey: null,
      completedAt: new Date(),
      errorMessage: "Application restarted before discovery reached a terminal state",
    },
  });
}

export const scanRunRepository = { start, finishDiscovery, fail, recoverRunning };

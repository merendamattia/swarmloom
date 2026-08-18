import { Prisma, type AgentProvider, type Job, type JobStatus } from "@prisma/client";
import { prisma } from "../core/db.ts";

export type QueuedJobInput = {
  repositoryId: string;
  scanRunId?: string;
  environment: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueBody: string;
  branchName: string;
  baselineCommit: string;
  provider: AgentProvider;
  model: string;
  reasoningEffort?: string;
};

export type BlockedByInput = {
  blockedByIssueNumber: number;
  blockedByIssueTitle: string;
  blockedByIssueUrl: string;
  blockedReason: string;
};

async function tryCreateQueued(input: QueuedJobInput) {
  const id = crypto.randomUUID();
  const [job] = await prisma.$queryRaw<Job[]>`
    INSERT INTO "job" (
      "id", "queueJobId", "repositoryId", "scanRunId", "environment", "issueNumber", "issueTitle", "issueUrl", "issueBody",
      "branchName", "baselineCommit", "provider", "model", "reasoningEffort", "activeIssueKey",
      "updatedAt"
    ) VALUES (
      ${id}, ${id}, ${input.repositoryId}, ${input.scanRunId ?? null}, ${input.environment}, ${input.issueNumber},
      ${input.issueTitle}, ${input.issueUrl}, ${input.issueBody}, ${input.branchName},
      ${input.baselineCommit}, ${input.provider}::"AgentProvider", ${input.model},
      ${input.reasoningEffort ?? null}, ${`${input.repositoryId}:${input.issueNumber}`}, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("activeIssueKey") DO NOTHING
    RETURNING *
  `;
  return job ?? null;
}

async function tryCreateDeferred(input: QueuedJobInput & BlockedByInput) {
  const id = crypto.randomUUID();
  const [job] = await prisma.$queryRaw<Job[]>`
    INSERT INTO "job" (
      "id", "queueJobId", "repositoryId", "scanRunId", "environment", "issueNumber", "issueTitle", "issueUrl", "issueBody",
      "branchName", "baselineCommit", "provider", "model", "reasoningEffort", "activeIssueKey", "status",
      "blockedByIssueNumber", "blockedByIssueTitle", "blockedByIssueUrl", "blockedReason",
      "updatedAt"
    ) VALUES (
      ${id}, ${id}, ${input.repositoryId}, ${input.scanRunId ?? null}, ${input.environment}, ${input.issueNumber},
      ${input.issueTitle}, ${input.issueUrl}, ${input.issueBody}, ${input.branchName},
      ${input.baselineCommit}, ${input.provider}::"AgentProvider", ${input.model},
      ${input.reasoningEffort ?? null}, ${`${input.repositoryId}:${input.issueNumber}`}, 'DEFERRED'::"JobStatus",
      ${input.blockedByIssueNumber}, ${input.blockedByIssueTitle}, ${input.blockedByIssueUrl}, ${input.blockedReason},
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("activeIssueKey") DO NOTHING
    RETURNING *
  `;
  return job ?? null;
}

async function promoteDeferred(activeIssueKey: string) {
  const [job] = await prisma.$queryRaw<Job[]>`
    UPDATE "job"
    SET "status" = 'QUEUED'::"JobStatus",
        "queuedAt" = CURRENT_TIMESTAMP,
        "blockedByIssueNumber" = NULL,
        "blockedByIssueTitle" = NULL,
        "blockedByIssueUrl" = NULL,
        "blockedReason" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "activeIssueKey" = ${activeIssueKey}
      AND "status" = 'DEFERRED'::"JobStatus"
    RETURNING *
  `;
  return job ?? null;
}

async function deferRunning(id: string, blocker: BlockedByInput) {
  const updated = await prisma.job.updateMany({
    where: { id, status: "RUNNING" },
    data: {
      status: "DEFERRED",
      workerId: null,
      heartbeatAt: null,
      blockedByIssueNumber: blocker.blockedByIssueNumber,
      blockedByIssueTitle: blocker.blockedByIssueTitle,
      blockedByIssueUrl: blocker.blockedByIssueUrl,
      blockedReason: blocker.blockedReason,
    },
  });
  return updated.count === 1;
}

async function claim(id: string, environment: string, workerId: string) {
  const [job] = await prisma.$queryRaw<Job[]>`
    UPDATE "job"
    SET "status" = 'RUNNING',
        "workerId" = ${workerId},
        "attempts" = "attempts" + 1,
        "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP),
        "heartbeatAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id}
      AND "environment" = ${environment}
      AND "status" = 'QUEUED'
    RETURNING *
  `;
  return job ?? null;
}

async function complete(id: string, result: Prisma.InputJsonValue, exitCode: number) {
  return finishRunning(id, "COMPLETED", { result, exitCode });
}

type FinishInput = {
  result?: Prisma.InputJsonValue;
  exitCode?: number;
  errorMessage?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
};

async function finishRunning(
  id: string,
  status: Extract<JobStatus, "COMPLETED" | "FAILED" | "BLOCKED" | "DECOMPOSED">,
  input: FinishInput,
) {
  const job = await prisma.job.findUnique({ where: { id }, select: { startedAt: true } });
  if (!job?.startedAt) return false;

  const completedAt = new Date();
  const updated = await prisma.job.updateMany({
    where: { id, status: "RUNNING" },
    data: {
      status,
      result: input.result,
      exitCode: input.exitCode,
      errorMessage: input.errorMessage,
      pullRequestNumber: input.pullRequestNumber,
      pullRequestUrl: input.pullRequestUrl,
      completedAt,
      durationMs: Math.max(0, completedAt.getTime() - job.startedAt.getTime()),
      activeIssueKey: null,
      heartbeatAt: null,
    },
  });
  return updated.count === 1;
}

async function findRunning(id: string, workerId: string) {
  return prisma.job.findFirst({
    where: { id, status: "RUNNING", workerId },
    include: { repository: true },
  });
}

async function setWorktree(id: string, worktreePath: string) {
  const updated = await prisma.job.updateMany({
    where: { id, status: "RUNNING" },
    data: { worktreePath },
  });
  return updated.count === 1;
}

async function setImplementationResult(id: string, sessionId: string | null, exitCode: number) {
  const updated = await prisma.job.updateMany({
    where: { id, status: "RUNNING" },
    data: { implementationSessionId: sessionId, exitCode },
  });
  return updated.count === 1;
}

async function cancel(id: string) {
  const updated = await prisma.job.updateMany({
    where: { id, status: { in: ["QUEUED", "RUNNING"] } },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      activeIssueKey: null,
      heartbeatAt: null,
    },
  });
  return updated.count === 1;
}

async function recoverStaleBefore(environment: string, cutoff: Date) {
  const candidates = await prisma.job.findMany({
    where: { environment, status: "RUNNING", heartbeatAt: { lt: cutoff } },
    select: { id: true },
  });
  if (candidates.length === 0) return [];
  const ids = candidates.map(({ id }) => id);
  const updated = await prisma.job.updateMany({
    where: { id: { in: ids }, status: "RUNNING", heartbeatAt: { lt: cutoff } },
    data: {
      status: "STALE",
      completedAt: new Date(),
      activeIssueKey: null,
      heartbeatAt: null,
      errorMessage: "Worker heartbeat expired before the job reached a terminal state",
    },
  });
  if (updated.count === 0) return [];
  return prisma.job.findMany({
    where: { id: { in: ids }, status: "STALE" },
    include: { repository: true },
  });
}

async function heartbeat(id: string, workerId: string) {
  const updated = await prisma.job.updateMany({
    where: { id, status: "RUNNING", workerId },
    data: { heartbeatAt: new Date() },
  });
  return updated.count === 1;
}

async function failQueued(id: string, errorMessage: string) {
  const completedAt = new Date();
  const updated = await prisma.job.updateMany({
    where: { id, status: "QUEUED" },
    data: {
      status: "FAILED",
      errorMessage,
      completedAt,
      activeIssueKey: null,
    },
  });
  return updated.count === 1;
}

export const jobRepository = {
  tryCreateQueued,
  tryCreateDeferred,
  promoteDeferred,
  deferRunning,
  claim,
  complete,
  cancel,
  recoverStaleBefore,
  heartbeat,
  failQueued,
  findRunning,
  setWorktree,
  setImplementationResult,
  finishRunning,
};

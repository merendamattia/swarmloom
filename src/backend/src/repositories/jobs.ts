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

export type DependencyBlockInput = Omit<QueuedJobInput, "scanRunId"> & {
  scanRunId: string | null;
  blockingIssueNumber: number;
  blockingIssueUrl: string;
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

async function promoteBlocked(
  repositoryId: string,
  issueNumber: number,
  environment: string,
  scanRunId: string | null,
  branchName: string,
  baselineCommit: string,
) {
  const [job] = await prisma.$queryRaw<Job[]>`
    UPDATE "job"
    SET "status" = 'QUEUED',
        "scanRunId" = ${scanRunId},
        "branchName" = ${branchName},
        "baselineCommit" = ${baselineCommit},
        "blockingIssueNumber" = NULL,
        "blockingIssueUrl" = NULL,
        "errorMessage" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "activeIssueKey" = ${`${repositoryId}:${issueNumber}`}
      AND "environment" = ${environment}
      AND "status" = 'BLOCKED'
    RETURNING *
  `;
  return job ?? null;
}

async function deferForDependency(input: DependencyBlockInput) {
  const activeIssueKey = `${input.repositoryId}:${input.issueNumber}`;
  const message = `Blocked by parent issue #${input.blockingIssueNumber}: ${input.blockingIssueUrl}`;
  const existing = await prisma.job.findUnique({ where: { activeIssueKey } });
  if (existing?.status === "RUNNING") {
    return { job: null, changed: false, cancelledQueuedJobId: null };
  }

  let cancelledQueuedJobId: string | null = null;
  if (existing?.status === "QUEUED") {
    await prisma.job.update({
      where: { id: existing.id },
      data: { status: "CANCELLED", activeIssueKey: null, completedAt: new Date(), heartbeatAt: null },
    });
    cancelledQueuedJobId = existing.queueJobId;
  }

  if (existing?.status === "BLOCKED") {
    const changed = existing.blockingIssueNumber !== input.blockingIssueNumber
      || existing.blockingIssueUrl !== input.blockingIssueUrl
      || existing.errorMessage !== message;
    const job = await prisma.job.update({
      where: { id: existing.id },
      data: {
        scanRunId: input.scanRunId,
        blockingIssueNumber: input.blockingIssueNumber,
        blockingIssueUrl: input.blockingIssueUrl,
        errorMessage: message,
      },
    });
    return { job, changed: changed || cancelledQueuedJobId !== null, cancelledQueuedJobId };
  }

  const id = crypto.randomUUID();
  const [job] = await prisma.$queryRaw<Job[]>`
    INSERT INTO "job" (
      "id", "queueJobId", "repositoryId", "scanRunId", "environment", "issueNumber", "issueTitle", "issueUrl", "issueBody",
      "branchName", "baselineCommit", "provider", "model", "reasoningEffort", "activeIssueKey",
      "blockingIssueNumber", "blockingIssueUrl", "errorMessage", "status", "updatedAt"
    ) VALUES (
      ${id}, ${id}, ${input.repositoryId}, ${input.scanRunId}, ${input.environment}, ${input.issueNumber},
      ${input.issueTitle}, ${input.issueUrl}, ${input.issueBody}, ${input.branchName},
      ${input.baselineCommit}, ${input.provider}::"AgentProvider", ${input.model},
      ${input.reasoningEffort ?? null}, ${activeIssueKey},
      ${input.blockingIssueNumber}, ${input.blockingIssueUrl}, ${message}, 'BLOCKED'::"JobStatus", CURRENT_TIMESTAMP
    )
    ON CONFLICT ("activeIssueKey") DO NOTHING
    RETURNING *
  `;
  return job
    ? { job, changed: true, cancelledQueuedJobId }
    : { job: null, changed: false, cancelledQueuedJobId };
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

async function findQueued(id: string) {
  return prisma.job.findFirst({
    where: { id, status: "QUEUED" },
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
  promoteBlocked,
  deferForDependency,
  claim,
  complete,
  cancel,
  recoverStaleBefore,
  heartbeat,
  failQueued,
  findRunning,
  findQueued,
  setWorktree,
  setImplementationResult,
  finishRunning,
};

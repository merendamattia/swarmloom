import { Prisma, type AgentProvider, type Job, type JobStatus, type JobSubject, type JobType } from "@prisma/client";
import { prisma } from "../core/db.ts";

export type QueuedJobInput = {
  repositoryId: string;
  scanRunId?: string;
  environment: string;
  jobType: JobType;
  subjectType: JobSubject;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueBody: string;
  branchName: string;
  baselineCommit: string;
  pullRequestId?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  headSha?: string;
  trigger?: string;
  provider: AgentProvider;
  model: string;
  reasoningEffort?: string;
};

function activeIssueKey(input: QueuedJobInput) {
  return input.subjectType === "ISSUE" ? `${input.repositoryId}:${input.issueNumber}` : null;
}

function activePrKey(input: QueuedJobInput) {
  if (input.subjectType !== "PULL_REQUEST" || !input.pullRequestId || !input.headSha) return null;
  return `${input.repositoryId}:${input.pullRequestId}:${input.headSha}:${input.jobType}`;
}

async function tryCreateQueued(input: QueuedJobInput) {
  const id = crypto.randomUUID();
  const [job] = await prisma.$queryRaw<Job[]>`
    INSERT INTO "job" (
      "id", "queueJobId", "repositoryId", "scanRunId", "environment", "jobType", "subjectType",
      "issueNumber", "issueTitle", "issueUrl", "issueBody", "branchName", "baselineCommit",
      "pullRequestId", "pullRequestNumber", "pullRequestUrl", "headSha", "trigger",
      "provider", "model", "reasoningEffort", "activeIssueKey", "activePrKey", "updatedAt"
    ) VALUES (
      ${id}, ${id}, ${input.repositoryId}, ${input.scanRunId ?? null}, ${input.environment},
      ${input.jobType}::"JobType", ${input.subjectType}::"JobSubject", ${input.issueNumber},
      ${input.issueTitle}, ${input.issueUrl}, ${input.issueBody}, ${input.branchName},
      ${input.baselineCommit}, ${input.pullRequestId ?? null}, ${input.pullRequestNumber ?? null},
      ${input.pullRequestUrl ?? null}, ${input.headSha ?? null}, ${input.trigger ?? null},
      ${input.provider}::"AgentProvider", ${input.model}, ${input.reasoningEffort ?? null},
      ${activeIssueKey(input)}, ${activePrKey(input)}, CURRENT_TIMESTAMP
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  return job ?? null;
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
  headSha?: string;
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
      headSha: input.headSha,
      completedAt,
      durationMs: Math.max(0, completedAt.getTime() - job.startedAt.getTime()),
      activeIssueKey: null,
      activePrKey: null,
      heartbeatAt: null,
    },
  });
  return updated.count === 1;
}

async function findRunning(id: string, workerId: string) {
  return prisma.job.findFirst({
    where: { id, status: "RUNNING", workerId },
    include: { repository: true, pullRequest: true },
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
      activePrKey: null,
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
      activePrKey: null,
      heartbeatAt: null,
      errorMessage: "Worker heartbeat expired before the job reached a terminal state",
    },
  });
  if (updated.count === 0) return [];
  return prisma.job.findMany({
    where: { id: { in: ids }, status: "STALE" },
    include: { repository: true, pullRequest: true },
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
      activePrKey: null,
    },
  });
  return updated.count === 1;
}

export const jobRepository = {
  tryCreateQueued,
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

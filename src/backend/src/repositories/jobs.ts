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
      "id", "repositoryId", "scanRunId", "environment", "jobType", "subjectType",
      "issueNumber", "issueTitle", "issueUrl", "issueBody", "branchName", "baselineCommit",
      "pullRequestId", "pullRequestNumber", "pullRequestUrl", "headSha", "trigger",
      "provider", "model", "reasoningEffort", "activeIssueKey", "activePrKey", "updatedAt"
    ) VALUES (
      ${id}, ${input.repositoryId}, ${input.scanRunId ?? null}, ${input.environment},
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
  const claimToken = crypto.randomUUID();
  const [job] = await prisma.$queryRaw<Job[]>`
    UPDATE "job"
    SET "status" = 'RUNNING',
        "workerId" = ${workerId},
        "claimToken" = ${claimToken},
        "cleanupToken" = NULL,
        "cleanupLeaseExpiresAt" = NULL,
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

const retryableStatuses: JobStatus[] = ["FAILED", "BLOCKED", "CANCELLED", "STALE"];

async function requeueForRetry(id: string, environment: string) {
  const job = await prisma.job.findFirst({ where: { id, environment } });
  if (
    !job
    || !retryableStatuses.includes(job.status as typeof retryableStatuses[number])
    || job.workerId
    || (job.status !== "FAILED" && job.worktreePath)
  ) return null;

  const updated = await prisma.job.updateMany({
    where: {
      id,
      environment,
      status: job.status,
      workerId: null,
      cleanupToken: null,
      ...(job.status !== "FAILED" ? { worktreePath: null } : {}),
    },
    data: {
      status: "QUEUED",
      queuedAt: new Date(),
      completedAt: null,
      durationMs: null,
      workerId: null,
      heartbeatAt: null,
      claimToken: null,
      cleanupToken: null,
      cleanupLeaseExpiresAt: null,
      activeIssueKey: job.subjectType === "ISSUE" ? `${job.repositoryId}:${job.issueNumber}` : null,
      activePrKey: job.subjectType === "PULL_REQUEST" && job.pullRequestId && job.headSha
        ? `${job.repositoryId}:${job.pullRequestId}:${job.headSha}:${job.jobType}`
        : null,
      worktreePath: job.status === "FAILED" ? undefined : null,
      sessionId: job.status === "FAILED" ? undefined : null,
      errorMessage: null,
    },
  });
  return updated.count === 1 ? prisma.job.findUnique({ where: { id } }) : null;
}

async function complete(id: string, claimToken: string, result: Prisma.InputJsonValue, exitCode: number) {
  return finishRunning(id, claimToken, "COMPLETED", { result, exitCode });
}

type FinishInput = {
  result?: Prisma.InputJsonValue;
  exitCode?: number;
  errorMessage?: string;
  diagnostics?: Prisma.InputJsonValue;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  headSha?: string;
};

async function finishRunning(
  id: string,
  claimToken: string,
  status: Extract<JobStatus, "COMPLETED" | "FAILED" | "BLOCKED" | "DECOMPOSED">,
  input: FinishInput,
) {
  const job = await prisma.job.findUnique({ where: { id }, select: { startedAt: true } });
  if (!job?.startedAt) return false;

  const completedAt = new Date();
  const updated = await prisma.job.updateMany({
    where: { id, claimToken, status: "RUNNING" },
    data: {
      status,
      result: input.result,
      exitCode: input.exitCode,
      diagnostics: input.diagnostics,
      pullRequestNumber: input.pullRequestNumber,
      pullRequestUrl: input.pullRequestUrl,
      headSha: input.headSha,
      completedAt,
      durationMs: Math.max(0, completedAt.getTime() - job.startedAt.getTime()),
      errorMessage: status === "FAILED" ? input.errorMessage ?? null : null,
      activeIssueKey: status === "FAILED" ? undefined : null,
      activePrKey: status === "FAILED" ? undefined : null,
      heartbeatAt: null,
    },
  });
  return updated.count === 1;
}

type SupportIssueClaim =
  | { kind: "missing" }
  | { kind: "not_failed" }
  | { kind: "existing"; issueNumber: number; issueUrl: string; repositoryId: string }
  | { kind: "in_progress" }
  | {
    kind: "claimed";
    job: NonNullable<Awaited<ReturnType<typeof findSupportIssueJob>>>;
    claimedAt: Date;
    reconcile: boolean;
  };

export const SUPPORT_ISSUE_LEASE_MS = 5 * 60_000;

async function findSupportIssueJob(id: string, environment: string) {
  return prisma.job.findFirst({
    where: { id, environment },
    include: { repository: true },
  });
}

async function claimSupportIssue(id: string, environment: string, leaseMs = SUPPORT_ISSUE_LEASE_MS): Promise<SupportIssueClaim> {
  const job = await findSupportIssueJob(id, environment);
  if (!job) return { kind: "missing" };
  if (job.status !== "FAILED") return { kind: "not_failed" };
  if (job.supportIssueNumber !== null && job.supportIssueUrl !== null) {
    return { kind: "existing", issueNumber: job.supportIssueNumber, issueUrl: job.supportIssueUrl, repositoryId: job.repositoryId };
  }
  const now = new Date();
  const staleBefore = new Date(now.getTime() - leaseMs);
  const reclaimable = !job.supportIssueCreating
    || job.supportIssueReconcileRequired
    || !job.supportIssueCreatingAt
    || job.supportIssueCreatingAt < staleBefore;
  if (!reclaimable) return { kind: "in_progress" };

  const claimed = await prisma.job.updateMany({
    where: {
      id,
      environment,
      status: "FAILED",
      supportIssueNumber: null,
      supportIssueUrl: null,
      OR: [
        { supportIssueCreating: false },
        { supportIssueCreating: true, supportIssueReconcileRequired: true },
        { supportIssueCreating: true, supportIssueCreatingAt: null },
        { supportIssueCreating: true, supportIssueCreatingAt: { lt: staleBefore } },
      ],
    },
    data: {
      supportIssueCreating: true,
      supportIssueCreatingAt: now,
      supportIssueReconcileRequired: false,
    },
  });
  if (claimed.count !== 1) {
    const concurrent = await findSupportIssueJob(id, environment);
    if (!concurrent) return { kind: "missing" };
    if (concurrent.status !== "FAILED") return { kind: "not_failed" };
    if (concurrent.supportIssueNumber !== null && concurrent.supportIssueUrl !== null) {
      return { kind: "existing", issueNumber: concurrent.supportIssueNumber, issueUrl: concurrent.supportIssueUrl, repositoryId: concurrent.repositoryId };
    }
    return { kind: "in_progress" };
  }

  const claimedJob = await findSupportIssueJob(id, environment);
  return claimedJob
    ? {
      kind: "claimed",
      job: claimedJob,
      claimedAt: claimedJob.supportIssueCreatingAt ?? now,
      reconcile: job.supportIssueCreating
        && (job.supportIssueReconcileRequired || !job.supportIssueCreatingAt || job.supportIssueCreatingAt < staleBefore),
    }
    : { kind: "missing" };
}

async function findSupportIssue(id: string, environment: string) {
  const job = await prisma.job.findFirst({
    where: { id, environment },
    select: { supportIssueNumber: true, supportIssueUrl: true },
  });
  if (!job || job.supportIssueNumber === null || job.supportIssueUrl === null) return null;
  return { issueNumber: job.supportIssueNumber, issueUrl: job.supportIssueUrl };
}

async function renewSupportIssue(id: string, environment: string, claimedAt: Date) {
  const renewedAt = new Date();
  const updated = await prisma.job.updateMany({
    where: {
      id,
      environment,
      status: "FAILED",
      supportIssueCreating: true,
      supportIssueCreatingAt: claimedAt,
      supportIssueNumber: null,
      supportIssueUrl: null,
    },
    data: { supportIssueCreatingAt: renewedAt },
  });
  return updated.count === 1 ? renewedAt : null;
}

async function saveSupportIssue(id: string, environment: string, claimedAt: Date, issue: { number: number; url: string }) {
  const updated = await prisma.job.updateMany({
    where: { id, environment, status: "FAILED", supportIssueCreating: true, supportIssueCreatingAt: claimedAt },
    data: {
      supportIssueNumber: issue.number,
      supportIssueUrl: issue.url,
      supportIssueCreating: false,
      supportIssueCreatingAt: null,
      supportIssueReconcileRequired: false,
    },
  });
  return updated.count === 1;
}

async function releaseSupportIssue(id: string, environment: string, claimedAt: Date) {
  const updated = await prisma.job.updateMany({
    where: { id, environment, supportIssueCreating: true, supportIssueCreatingAt: claimedAt },
    data: {
      supportIssueCreating: false,
      supportIssueCreatingAt: null,
      supportIssueReconcileRequired: false,
    },
  });
  return updated.count === 1;
}

async function markSupportIssueForReconciliation(id: string, environment: string, claimedAt: Date) {
  const updated = await prisma.job.updateMany({
    where: { id, environment, supportIssueCreating: true, supportIssueCreatingAt: claimedAt },
    data: {
      supportIssueCreating: true,
      supportIssueCreatingAt: new Date(0),
      supportIssueReconcileRequired: true,
    },
  });
  return updated.count === 1;
}

async function findRunning(id: string, workerId: string, claimToken: string) {
  return prisma.job.findFirst({
    where: { id, status: "RUNNING", workerId, claimToken },
    include: { repository: true, pullRequest: true },
  });
}

async function findCancelledWorktrees(environment: string, staleBefore: Date) {
  return prisma.job.findMany({
    where: {
      environment,
      status: "CANCELLED",
      worktreePath: { not: null },
      OR: [{ workerId: null }, { heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
    },
    include: { repository: true },
    orderBy: { completedAt: "asc" },
  });
}

async function isActiveClaim(id: string, workerId: string | null, claimToken: string | null) {
  if (!workerId || !claimToken) return false;
  const job = await prisma.job.findFirst({
    where: { id, status: "RUNNING", workerId, claimToken },
    select: { id: true },
  });
  return job !== null;
}

async function findQueued(environment: string) {
  return prisma.job.findMany({
    where: { environment, status: "QUEUED", workerId: null },
    select: { id: true },
  });
}

async function setWorktree(id: string, claimToken: string, worktreePath: string) {
  const updated = await prisma.job.updateMany({
    where: { id, claimToken, status: "RUNNING" },
    data: { worktreePath },
  });
  return updated.count === 1;
}

async function setSessionId(id: string, claimToken: string, sessionId: string) {
  const updated = await prisma.job.updateMany({
    where: { id, claimToken, status: "RUNNING" },
    data: { sessionId },
  });
  return updated.count === 1;
}

async function setExecutionResult(id: string, claimToken: string, sessionId: string | null, exitCode: number) {
  const updated = await prisma.job.updateMany({
    where: { id, claimToken, status: "RUNNING" },
    data: { sessionId: sessionId ?? undefined, exitCode },
  });
  return updated.count === 1;
}

const cleanupStatuses: JobStatus[] = ["COMPLETED", "FAILED", "BLOCKED", "DECOMPOSED", "CANCELLED", "STALE"];
const terminalCleanupStatuses: JobStatus[] = ["COMPLETED", "BLOCKED", "DECOMPOSED", "CANCELLED", "STALE"];
export const WORKTREE_CLEANUP_LEASE_MS = 5 * 60_000;

async function claimWorktreeCleanup(
  id: string,
  workerId: string | null,
  claimToken: string | null,
  expectedPath?: string,
  leaseMs = WORKTREE_CLEANUP_LEASE_MS,
) {
  const cleanupToken = crypto.randomUUID();
  const cleanupLeaseExpiresAt = new Date(Date.now() + leaseMs);
  const updated = await prisma.job.updateMany({
    where: {
      id,
      workerId,
      claimToken,
      cleanupToken: null,
      status: { in: cleanupStatuses },
      ...(expectedPath
        ? { OR: [{ worktreePath: expectedPath }, { worktreePath: null }] }
        : { worktreePath: { not: null } }),
    },
    data: {
      cleanupToken,
      cleanupLeaseExpiresAt,
      ...(expectedPath ? { worktreePath: expectedPath } : {}),
    },
  });
  if (updated.count !== 1) return null;
  const job = await prisma.job.findUnique({ where: { id }, select: { worktreePath: true } });
  return job?.worktreePath ? { path: job.worktreePath, cleanupToken } : null;
}

async function reclaimTerminalWorktreeCleanup(
  id: string,
  expectedPath: string,
  leaseMs = WORKTREE_CLEANUP_LEASE_MS,
) {
  const now = new Date();
  const cleanupToken = crypto.randomUUID();
  const cleanupLeaseExpiresAt = new Date(now.getTime() + leaseMs);
  const staleBefore = new Date(now.getTime() - leaseMs);
  const updated = await prisma.job.updateMany({
    where: {
      id,
      status: { in: cleanupStatuses },
      worktreePath: expectedPath,
      OR: [
        {
          cleanupToken: { not: null },
          OR: [{ cleanupLeaseExpiresAt: null }, { cleanupLeaseExpiresAt: { lt: now } }],
        },
        {
          status: { in: terminalCleanupStatuses },
          cleanupToken: null,
          completedAt: { lt: staleBefore },
        },
      ],
    },
    data: {
      cleanupToken,
      cleanupLeaseExpiresAt,
      workerId: null,
      claimToken: null,
      heartbeatAt: null,
    },
  });
  if (updated.count !== 1) return null;
  const job = await prisma.job.findUnique({ where: { id }, select: { worktreePath: true } });
  return job?.worktreePath ? { path: job.worktreePath, cleanupToken } : null;
}

async function findTerminalRecoveryJobs(environment: string) {
  return prisma.job.findMany({
    where: {
      environment,
      status: { in: cleanupStatuses },
      OR: [
        { worktreePath: { not: null } },
        { workerId: { not: null } },
        { cleanupToken: { not: null } },
      ],
    },
    include: { repository: true },
  });
}

async function clearWorktree(id: string, claimToken: string | null, cleanupToken: string) {
  const updated = await prisma.job.updateMany({
    where: { id, claimToken, cleanupToken, status: { in: cleanupStatuses }, worktreePath: { not: null } },
    data: { worktreePath: null, cleanupToken: null, cleanupLeaseExpiresAt: null },
  });
  return updated.count === 1;
}

async function releaseWorker(id: string, workerId: string | null, claimToken: string | null, releaseStale = false) {
  const updated = await prisma.job.updateMany({
    where: {
      id,
      workerId,
      claimToken,
      cleanupToken: null,
      status: { in: releaseStale ? cleanupStatuses : cleanupStatuses.filter((status) => status !== "STALE") },
      OR: [{ status: "FAILED" }, { worktreePath: null }],
    },
    data: {
      workerId: null,
      claimToken: null,
      heartbeatAt: null,
      cleanupLeaseExpiresAt: null,
      activeIssueKey: releaseStale ? null : undefined,
      activePrKey: releaseStale ? null : undefined,
    },
  });
  return updated.count === 1;
}

async function discardTerminalJob(id: string, claimToken: string | null) {
  const updated = await prisma.job.updateMany({
    where: { id, status: { in: retryableStatuses }, workerId: null, claimToken, cleanupToken: null, worktreePath: null },
    data: { activeIssueKey: null, activePrKey: null, workerId: null, claimToken: null, heartbeatAt: null },
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

async function heartbeat(id: string, workerId: string, claimToken: string) {
  const updated = await prisma.job.updateMany({
    where: { id, status: "RUNNING", workerId, claimToken },
    data: { heartbeatAt: new Date() },
  });
  return updated.count === 1;
}

async function failQueued(id: string, errorMessage: string, retainActiveKey = false) {
  const completedAt = new Date();
  const updated = await prisma.job.updateMany({
    where: { id, status: "QUEUED" },
    data: {
      status: "FAILED",
      errorMessage,
      completedAt,
      activeIssueKey: retainActiveKey ? undefined : null,
      activePrKey: retainActiveKey ? undefined : null,
    },
  });
  return updated.count === 1;
}

export const jobRepository = {
  tryCreateQueued,
  claim,
  requeueForRetry,
  complete,
  cancel,
  recoverStaleBefore,
  heartbeat,
  failQueued,
  findRunning,
  findQueued,
  setWorktree,
  setSessionId,
  setExecutionResult,
  claimWorktreeCleanup,
  clearWorktree,
  releaseWorker,
  discardTerminalJob,
  finishRunning,
  claimSupportIssue,
  findSupportIssue,
  saveSupportIssue,
  renewSupportIssue,
  releaseSupportIssue,
  markSupportIssueForReconciliation,
  isActiveClaim,
  findTerminalRecoveryJobs,
  findCancelledWorktrees,
  reclaimTerminalWorktreeCleanup,
};

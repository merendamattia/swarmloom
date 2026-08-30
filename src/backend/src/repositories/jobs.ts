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

export type QuotaWaitInput = {
  resetAt?: string | null;
  window?: string | null;
  usedPercent?: number | null;
  message?: string | null;
  diagnostics?: Prisma.InputJsonValue;
  sessionId?: string | null;
  exitCode?: number | null;
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
        "attempts" = "attempts" + 1,
        "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP),
        "activeStartedAt" = CURRENT_TIMESTAMP,
        "heartbeatAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id}
      AND "environment" = ${environment}
      AND "status" = 'QUEUED'
    RETURNING *
  `;
  return job ?? null;
}

async function findQueued(id: string, environment: string) {
  return prisma.job.findFirst({
    where: { id, environment, status: "QUEUED" },
    select: { id: true, provider: true },
  });
}

async function findQueuedJobs(environment: string) {
  return prisma.job.findMany({
    where: { environment, status: "QUEUED" },
    select: {
      id: true,
      repositoryId: true,
      issueNumber: true,
      issueUrl: true,
      jobType: true,
    },
    orderBy: { queuedAt: "asc" },
  });
}

function quotaResetAt(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function quotaWaitData(input: QuotaWaitInput) {
  return {
    quotaWaitStartedAt: new Date(),
    quotaResetAt: quotaResetAt(input.resetAt),
    quotaWindow: input.window ?? null,
    quotaUsedPercent: input.usedPercent ?? null,
    quotaMessage: input.message ?? null,
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
  };
}

async function waitForQuotaQueued(id: string, environment: string, input: QuotaWaitInput) {
  const updated = await prisma.job.updateMany({
    where: { id, environment, status: "QUEUED" },
    data: {
      status: "WAITING_FOR_QUOTA",
      ...quotaWaitData(input),
      workerId: null,
      claimToken: null,
      cleanupToken: null,
      heartbeatAt: null,
      activeStartedAt: null,
    },
  });
  return updated.count === 1;
}

async function waitForQuotaRunning(id: string, environment: string, workerId: string, claimToken: string, input: QuotaWaitInput) {
  const job = await prisma.job.findFirst({
    where: { id, environment, status: "RUNNING", workerId, claimToken },
    select: { activeStartedAt: true, startedAt: true, activeDurationMs: true },
  });
  if (!job) return false;
  const now = new Date();
  const activeStartedAt = job.activeStartedAt ?? job.startedAt;
  const activeDurationMs = (job.activeDurationMs ?? 0) + (activeStartedAt
    ? Math.max(0, now.getTime() - activeStartedAt.getTime())
    : 0);
  const updated = await prisma.job.updateMany({
    where: { id, environment, status: "RUNNING", workerId, claimToken },
    data: {
      status: "WAITING_FOR_QUOTA",
      ...quotaWaitData(input),
      activeStartedAt: null,
      activeDurationMs,
      durationMs: activeDurationMs,
      workerId: null,
      claimToken: null,
      cleanupToken: null,
      heartbeatAt: null,
    },
  });
  return updated.count === 1;
}

async function findWaitingForQuota(environment: string, provider: AgentProvider = "CODEX") {
  return prisma.job.findMany({
    where: { environment, provider, status: "WAITING_FOR_QUOTA" },
    include: { repository: true },
    orderBy: { quotaWaitStartedAt: "asc" },
  });
}

async function findCancelledWorktrees(environment: string) {
  return prisma.job.findMany({
    where: {
      environment,
      status: "CANCELLED",
      worktreePath: { not: null },
    },
    include: { repository: true },
    orderBy: { completedAt: "asc" },
  });
}

const cleanupStatuses: JobStatus[] = ["COMPLETED", "FAILED", "BLOCKED", "DECOMPOSED", "CANCELLED", "STALE"];

async function claimWorktreeCleanup(
  id: string,
  workerId: string | null,
  claimToken: string | null,
  expectedPath?: string,
) {
  const cleanupToken = crypto.randomUUID();
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
      ...(expectedPath ? { worktreePath: expectedPath } : {}),
    },
  });
  if (updated.count !== 1) return null;
  const job = await prisma.job.findUnique({ where: { id }, select: { worktreePath: true } });
  return job?.worktreePath ? { path: job.worktreePath, cleanupToken } : null;
}

async function clearWorktree(id: string, claimToken: string | null, cleanupToken: string) {
  const updated = await prisma.job.updateMany({
    where: { id, claimToken, cleanupToken, status: { in: cleanupStatuses }, worktreePath: { not: null } },
    data: { worktreePath: null, cleanupToken: null, worktreeCleanupRequired: false },
  });
  return updated.count === 1;
}

async function requeueWaitingForQuota(id: string, environment: string) {
  const job = await prisma.job.findFirst({
    where: { id, environment, status: "WAITING_FOR_QUOTA" },
    select: { quotaWaitStartedAt: true, quotaWaitDurationMs: true },
  });
  if (!job) return null;
  const now = new Date();
  const quotaWaitDurationMs = (job.quotaWaitDurationMs ?? 0) + (job.quotaWaitStartedAt
    ? Math.max(0, now.getTime() - job.quotaWaitStartedAt.getTime())
    : 0);
  const updated = await prisma.job.updateMany({
    where: { id, environment, status: "WAITING_FOR_QUOTA" },
    data: {
      status: "QUEUED",
      completedAt: null,
      quotaWaitDurationMs,
      quotaWaitStartedAt: null,
      activeStartedAt: null,
      workerId: null,
      claimToken: null,
      cleanupToken: null,
      heartbeatAt: null,
    },
  });
  if (updated.count !== 1) return null;
  return prisma.job.findUnique({ where: { id }, include: { repository: true } });
}

const retryableStatuses = ["FAILED", "BLOCKED", "CANCELLED", "STALE"] as const;

async function requeueForRetry(id: string, environment: string) {
  const job = await prisma.job.findFirst({ where: { id, environment } });
  if (
    !job
    || !retryableStatuses.includes(job.status as typeof retryableStatuses[number])
    || job.workerId
    || job.cleanupToken
    || (job.status !== "FAILED" && job.worktreePath)
  ) return null;

  const updated = await prisma.job.updateMany({
    where: {
      id,
      environment,
      status: job.status,
      workerId: null,
      claimToken: job.claimToken,
      cleanupToken: null,
      ...(job.status !== "FAILED" ? { worktreePath: null } : {}),
    },
    data: {
      status: "QUEUED",
      queuedAt: new Date(),
      completedAt: null,
      durationMs: null,
      workerId: null,
      claimToken: null,
      cleanupToken: null,
      heartbeatAt: null,
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

async function discardFailedJob(id: string, claimToken: string | null) {
  const updated = await prisma.job.updateMany({
    where: { id, status: "FAILED", workerId: null, claimToken, cleanupToken: null, worktreePath: null },
    data: { activeIssueKey: null, activePrKey: null, claimToken: null, worktreeCleanupRequired: false },
  });
  return updated.count === 1;
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
  const job = await prisma.job.findUnique({
    where: { id },
    select: { startedAt: true, activeStartedAt: true, activeDurationMs: true },
  });
  if (!job?.startedAt) return false;

  const completedAt = new Date();
  const activeStartedAt = job.activeStartedAt ?? job.startedAt;
  const activeDurationMs = (job.activeDurationMs ?? 0) + (activeStartedAt
    ? Math.max(0, completedAt.getTime() - activeStartedAt.getTime())
    : 0);
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
      durationMs: activeDurationMs,
      activeDurationMs,
      activeStartedAt: null,
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

async function releaseWorker(id: string, workerId: string | null, claimToken: string | null) {
  const updated = await prisma.job.updateMany({
    where: {
      id,
      workerId,
      claimToken,
      cleanupToken: null,
      status: { in: ["COMPLETED", "FAILED", "BLOCKED", "DECOMPOSED", "CANCELLED", "STALE"] },
      OR: [{ status: "FAILED" }, { worktreePath: null }],
    },
    data: { workerId: null, claimToken: null, heartbeatAt: null },
  });
  return updated.count === 1;
}

async function cancel(id: string) {
  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      status: true,
      quotaWaitStartedAt: true,
      quotaWaitDurationMs: true,
      activeStartedAt: true,
      activeDurationMs: true,
      worktreePath: true,
      workerId: true,
      claimToken: true,
    },
  });
  if (!job || !["QUEUED", "RUNNING", "WAITING_FOR_QUOTA"].includes(job.status)) return false;
  const completedAt = new Date();
  const activeDurationMs = (job.activeDurationMs ?? 0) + (job.status === "RUNNING" && job.activeStartedAt
    ? Math.max(0, completedAt.getTime() - job.activeStartedAt.getTime())
    : 0);
  const quotaWaitDurationMs = (job.quotaWaitDurationMs ?? 0) + (job.status === "WAITING_FOR_QUOTA" && job.quotaWaitStartedAt
    ? Math.max(0, completedAt.getTime() - job.quotaWaitStartedAt.getTime())
    : 0);
  const updated = await prisma.job.updateMany({
    where: { id, status: job.status, workerId: job.workerId, claimToken: job.claimToken },
    data: {
      status: "CANCELLED",
      completedAt,
      activeIssueKey: null,
      activePrKey: null,
      activeStartedAt: null,
      activeDurationMs,
      durationMs: job.status === "RUNNING" ? activeDurationMs : undefined,
      quotaWaitStartedAt: null,
      quotaWaitDurationMs,
      worktreeCleanupRequired: Boolean(job.worktreePath),
      heartbeatAt: null,
    },
  });
  return updated.count === 1;
}

async function recoverStaleBefore(environment: string, cutoff: Date) {
  const candidates = await prisma.job.findMany({
    where: { environment, status: "RUNNING", heartbeatAt: { lt: cutoff } },
    select: { id: true, workerId: true, claimToken: true, activeStartedAt: true, startedAt: true, activeDurationMs: true },
  });
  if (candidates.length === 0) return [];
  const completedAt = new Date();
  const recoveredIds: string[] = [];
  for (const candidate of candidates) {
    const activeStartedAt = candidate.activeStartedAt ?? candidate.startedAt;
    const activeDurationMs = (candidate.activeDurationMs ?? 0) + (activeStartedAt
      ? Math.max(0, completedAt.getTime() - activeStartedAt.getTime())
      : 0);
    const updated = await prisma.job.updateMany({
      where: { id: candidate.id, status: "RUNNING", heartbeatAt: { lt: cutoff } },
      data: {
        status: "STALE",
        completedAt,
        durationMs: activeDurationMs,
        activeDurationMs,
        activeStartedAt: null,
        activeIssueKey: null,
        activePrKey: null,
        heartbeatAt: null,
        errorMessage: "Worker heartbeat expired before the job reached a terminal state",
      },
    });
    if (updated.count === 1) recoveredIds.push(candidate.id);
  }
  if (recoveredIds.length === 0) return [];
  return prisma.job.findMany({
    where: { id: { in: recoveredIds }, status: "STALE" },
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
  findQueued,
  findQueuedJobs,
  claim,
  waitForQuotaQueued,
  waitForQuotaRunning,
  findWaitingForQuota,
  requeueWaitingForQuota,
  findCancelledWorktrees,
  claimWorktreeCleanup,
  requeueForRetry,
  complete,
  cancel,
  recoverStaleBefore,
  heartbeat,
  failQueued,
  findRunning,
  setWorktree,
  setSessionId,
  setExecutionResult,
  clearWorktree,
  releaseWorker,
  discardFailedJob,
  finishRunning,
  claimSupportIssue,
  findSupportIssue,
  saveSupportIssue,
  renewSupportIssue,
  releaseSupportIssue,
  markSupportIssueForReconciliation,
};

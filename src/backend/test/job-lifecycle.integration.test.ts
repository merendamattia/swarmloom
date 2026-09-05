import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config-schema.ts";
import type { GitHubClient } from "../src/github/client.ts";

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("PostgreSQL job lifecycle", () => {
  let prisma: typeof import("../src/core/db.ts").prisma;
  let jobs: typeof import("../src/repositories/jobs.ts").jobRepository;
  let repositoryId = "";
  let managedPrId = "";
  const environment = `test-${crypto.randomUUID()}`;
  const issuePrefix = Math.floor(Math.random() * 100_000) + 100_000;
  const config = parseConfig({
    APP_ENV: "test",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused:unused@localhost:5432/unused",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:18422",
    SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY ?? "test-settings-encryption-key-0123456789",
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORIES: "test/lifecycle",
    AGENT_PROVIDER: "codex",
  });

  beforeAll(async () => {
    ({ prisma } = await import("../src/core/db.ts"));
    ({ jobRepository: jobs } = await import("../src/repositories/jobs.ts"));
    repositoryId = (await prisma.repository.create({
      data: {
        fullName: `test/lifecycle-${crypto.randomUUID()}`,
        cloneUrl: "https://github.com/test/lifecycle.git",
      },
    })).id;
    managedPrId = (await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber: 500,
        issueNumber: issuePrefix,
        issueTitle: `Issue ${issuePrefix}`,
        issueUrl: `https://github.com/test/lifecycle/issues/${issuePrefix}`,
        headBranch: `agent/issue-${issuePrefix}`,
        headSha: "c".repeat(40),
        baseBranch: "develop",
      },
    })).id;
  });

  afterAll(async () => {
    await prisma.managedPullRequest.deleteMany({ where: { repositoryId } });
    await prisma.job.deleteMany({ where: { repositoryId } });
    await prisma.repository.delete({ where: { id: repositoryId } });
    await prisma.$disconnect();
  });

  test("claims once, guards completion, and releases the issue for a later retry", async () => {
    const input = queuedJob(issuePrefix);
    const queued = await jobs.tryCreateQueued(input);
    expect(queued?.status).toBe("QUEUED");
    expect(queued?.jobType).toBe("IMPLEMENTATION");
    expect(queued?.subjectType).toBe("ISSUE");
    expect(await jobs.tryCreateQueued(input)).toBeNull();

    const claimed = await jobs.claim(queued!.id, environment, "test-worker");
    expect(claimed?.id).toBe(queued?.id);
    expect(claimed?.status).toBe("RUNNING");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.provider).toBe("CODEX");
    expect(claimed?.model).toBe("gpt-5.6-luna");

    expect(await jobs.complete(claimed!.id, claimed!.claimToken!, { outcome: "implemented" }, 0)).toBe(true);
    expect(await jobs.complete(claimed!.id, claimed!.claimToken!, { outcome: "duplicate" }, 0)).toBe(false);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } })).activeIssueKey)
      .toBeNull();
    const retry = await jobs.tryCreateQueued(input);
    expect(retry).not.toBeNull();
    expect(await jobs.cancel(retry!.id)).toBe(true);
  });

  test("reclaims an expired failed pull request retry cleanup lease during terminal recovery", async () => {
    const failed = await jobs.tryCreateQueued(queuedPrJob("REVIEW", "f".repeat(40), config.APP_ENV));
    const worktreePath = `/data/worktrees/${failed!.id}`;
    await prisma.job.update({
      where: { id: failed!.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        worktreePath,
        activePrKey: `${repositoryId}:${managedPrId}:${"f".repeat(40)}:REVIEW`,
      },
    });

    const cleanup = await jobs.claimWorktreeCleanup(failed!.id, null, null, worktreePath);
    expect(cleanup).toMatchObject({ path: worktreePath });

    const { recoverTerminalJobs } = await import("../src/worker/recovery.ts");
    const { createEventService } = await import("../src/events/service.ts");
    const events = createEventService();
    const failedRemoval = await recoverTerminalJobs(
      config,
      events,
      async () => { throw new Error("worktree remover failed"); },
    );
    expect(failedRemoval).toBe(0);

    await prisma.$executeRaw`
      UPDATE "job"
      SET "cleanupLeaseExpiresAt" = ${new Date(Date.now() - 1)}
      WHERE "id" = ${failed!.id}
    `;
    const removed: string[] = [];
    expect(await recoverTerminalJobs(
      config,
      events,
      async ({ worktreePath: path }) => { removed.push(path); },
    )).toBe(1);

    expect(removed).toEqual([worktreePath]);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: failed!.id } })).toMatchObject({
      status: "FAILED",
      activePrKey: null,
      worktreePath: null,
      workerId: null,
      claimToken: null,
      cleanupToken: null,
      cleanupLeaseExpiresAt: null,
    });
    expect(await jobs.requeueForRetry(failed!.id, config.APP_ENV)).toMatchObject({ status: "QUEUED" });
  });

  test("reclaims a failed cancelled-worktree cleanup after its lease expires", async () => {
    const queued = await jobs.tryCreateQueued(queuedJob(issuePrefix + 26, config.APP_ENV));
    const claimed = await jobs.claim(queued!.id, config.APP_ENV, "cleanup-worker");
    const worktreePath = `/data/worktrees/${claimed!.id}`;
    await prisma.job.update({ where: { id: queued!.id }, data: { worktreePath } });
    expect(await jobs.cancel(queued!.id)).toBe(true);
    await prisma.$executeRaw`
      UPDATE "job"
      SET "heartbeatAt" = ${new Date(Date.now() - config.STALE_JOB_THRESHOLD_MS - 1)}
      WHERE "id" = ${queued!.id}
    `;

    const { recoverCancelledWorktrees } = await import("../src/worktrees/recovery.ts");
    const { createEventService } = await import("../src/events/service.ts");
    let removeAttempts = 0;
    expect(await recoverCancelledWorktrees(
      config,
      createEventService(),
      async () => {
        removeAttempts += 1;
        throw new Error("worktree remover failed");
      },
    )).toBe(0);

    const [claimedCleanup] = await prisma.$queryRaw<Array<{ cleanupToken: string | null; cleanupLeaseExpiresAt: Date | null }>>`
      SELECT "cleanupToken", "cleanupLeaseExpiresAt"
      FROM "job"
      WHERE "id" = ${queued!.id}
    `;
    expect(claimedCleanup?.cleanupToken).not.toBeNull();
    expect(claimedCleanup?.cleanupLeaseExpiresAt).not.toBeNull();

    await prisma.$executeRaw`
      UPDATE "job"
      SET "cleanupLeaseExpiresAt" = ${new Date(Date.now() - 1)}
      WHERE "id" = ${queued!.id}
    `;
    const removed: string[] = [];
    expect(await recoverCancelledWorktrees(
      config,
      createEventService(),
      async ({ worktreePath: path }) => { removeAttempts += 1; removed.push(path); },
    )).toBe(1);

    expect(removeAttempts).toBe(2);
    expect(removed).toEqual([worktreePath]);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: queued!.id } })).toMatchObject({
      status: "CANCELLED",
      worktreePath: null,
      worktreeCleanupRequired: false,
      workerId: null,
      claimToken: null,
      cleanupToken: null,
    });
    expect(await jobs.requeueForRetry(queued!.id, config.APP_ENV)).toMatchObject({ status: "QUEUED" });
  });

  test("reconciles terminal claims left by a crash after finalization and permits retry", async () => {
    const failed = await jobs.tryCreateQueued(queuedJob(issuePrefix + 27, config.APP_ENV));
    const failedClaim = await jobs.claim(failed!.id, config.APP_ENV, "terminal-worker");
    expect(await jobs.finishRunning(failed!.id, failedClaim!.claimToken!, "FAILED", {
      errorMessage: "provider failed after finalization",
    })).toBe(true);
    expect(await jobs.requeueForRetry(failed!.id, environment)).toBeNull();

    const completed = await jobs.tryCreateQueued(queuedJob(issuePrefix + 28, config.APP_ENV));
    const completedClaim = await jobs.claim(completed!.id, config.APP_ENV, "terminal-worker");
    const completedPath = `/data/worktrees/${completed!.id}`;
    expect(await jobs.setWorktree(completed!.id, completedClaim!.claimToken!, completedPath)).toBe(true);
    expect(await jobs.finishRunning(completed!.id, completedClaim!.claimToken!, "COMPLETED", {
      result: { outcome: "implemented" },
    })).toBe(true);

    const { recoverTerminalJobs } = await import("../src/worker/recovery.ts");
    const { createEventService } = await import("../src/events/service.ts");
    const removed: string[] = [];
    expect(await recoverTerminalJobs(
      config,
      createEventService(),
      async ({ worktreePath: path }) => { removed.push(path); },
    )).toBeGreaterThan(0);

    expect(removed).toContain(completedPath);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: failed!.id } })).toMatchObject({
      status: "FAILED",
      workerId: null,
      claimToken: null,
    });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: completed!.id } })).toMatchObject({
      status: "COMPLETED",
      worktreePath: null,
      workerId: null,
      claimToken: null,
      cleanupToken: null,
    });
    expect(await jobs.requeueForRetry(failed!.id, config.APP_ENV)).toMatchObject({ status: "QUEUED" });
  });

  test("rearms the same failed job and keeps its recovery state", async () => {
    const queued = await jobs.tryCreateQueued(queuedJob(issuePrefix + 20));
    const claimed = await jobs.claim(queued!.id, environment, "test-worker");
    const worktreePath = `/data/worktrees/${claimed!.id}`;
    await prisma.job.update({
      where: { id: claimed!.id },
      data: {
        status: "FAILED",
        activeIssueKey: null,
        workerId: null,
        worktreePath,
        sessionId: "session-20",
        errorMessage: "provider failed",
        completedAt: new Date(),
      },
    });

    const rearmed = await jobs.requeueForRetry(claimed!.id, environment);

    expect(rearmed).toMatchObject({
      id: claimed!.id,
      status: "QUEUED",
      activeIssueKey: `${repositoryId}:${issuePrefix + 20}`,
      worktreePath,
      sessionId: "session-20",
      attempts: 1,
      errorMessage: null,
    });
    expect(await jobs.requeueForRetry(claimed!.id, environment)).toBeNull();

    const retriedClaim = await jobs.claim(claimed!.id, environment, "test-worker");
    expect(retriedClaim).not.toBeNull();
    await prisma.job.update({ where: { id: claimed!.id }, data: { errorMessage: "stale retry error" } });
    expect(await jobs.complete(claimed!.id, (await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } })).claimToken!, { outcome: "implemented" }, 0)).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } })).errorMessage).toBeNull();
  });

  test("rejects every stale claim transition after the same job is reclaimed", async () => {
    const queued = await jobs.tryCreateQueued(queuedJob(issuePrefix + 22));
    const first = await jobs.claim(queued!.id, environment, "same-worker");
    await prisma.job.update({
      where: { id: queued!.id },
      data: { heartbeatAt: new Date(Date.now() - 120_000) },
    });

    expect(await jobs.recoverStaleBefore(environment, new Date(Date.now() - 60_000))).toHaveLength(1);
    expect(await jobs.releaseWorker(queued!.id, "same-worker", first!.claimToken!)).toBe(true);
    expect(await jobs.requeueForRetry(queued!.id, environment)).not.toBeNull();
    const second = await jobs.claim(queued!.id, environment, "same-worker");
    expect(second?.claimToken).not.toBe(first?.claimToken);

    expect(await jobs.finishRunning(queued!.id, first!.claimToken!, "FAILED", { errorMessage: "stale" })).toBe(false);
    expect(await jobs.heartbeat(queued!.id, "same-worker", first!.claimToken!)).toBe(false);
    expect(await jobs.setSessionId(queued!.id, first!.claimToken!, "stale-session")).toBe(false);
    expect(await jobs.setExecutionResult(queued!.id, first!.claimToken!, "stale-session", 1)).toBe(false);
    expect(await jobs.setWorktree(queued!.id, first!.claimToken!, "/tmp/stale-worktree")).toBe(false);
    expect(await jobs.claimWorktreeCleanup(queued!.id, "same-worker", first!.claimToken!, "/tmp/stale-worktree")).toBeNull();
    expect(await jobs.clearWorktree(queued!.id, first!.claimToken!, "stale-cleanup-token")).toBe(false);
    expect(await jobs.releaseWorker(queued!.id, "same-worker", first!.claimToken!)).toBe(false);

    expect(await prisma.job.findUniqueOrThrow({ where: { id: queued!.id } })).toMatchObject({
      status: "RUNNING",
      workerId: "same-worker",
      claimToken: second!.claimToken,
      sessionId: null,
      errorMessage: null,
    });
  });

  test("retries a terminal row after migration releases legacy worker ownership", async () => {
    const queued = await jobs.tryCreateQueued(queuedJob(issuePrefix + 23));
    const claimed = await jobs.claim(queued!.id, environment, "legacy-worker");
    await prisma.job.update({
      where: { id: claimed!.id },
      data: {
        status: "FAILED",
        activeIssueKey: null,
        workerId: "legacy-worker",
        heartbeatAt: new Date(Date.now() - 120_000),
        completedAt: new Date(),
      },
    });

    await prisma.$executeRaw`UPDATE "job" SET "workerId" = NULL, "heartbeatAt" = NULL WHERE "id" = ${claimed!.id}`;

    expect(await jobs.requeueForRetry(claimed!.id, environment)).toMatchObject({
      id: claimed!.id,
      status: "QUEUED",
      activeIssueKey: `${repositoryId}:${issuePrefix + 23}`,
    });
  });

  test("does not requeue a cancelled worker until its cleanup releases the retained worktree", async () => {
    const queued = await jobs.tryCreateQueued(queuedJob(issuePrefix + 21));
    const claimed = await jobs.claim(queued!.id, environment, "test-worker");
    const worktreePath = `/data/worktrees/${claimed!.id}`;
    await prisma.job.update({
      where: { id: claimed!.id },
      data: { worktreePath, sessionId: "cancelled-session", heartbeatAt: new Date() },
    });

    expect(await jobs.cancel(claimed!.id)).toBe(true);
    expect(await jobs.requeueForRetry(claimed!.id, environment)).toBeNull();
    expect(await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } })).toMatchObject({
      status: "CANCELLED",
      workerId: "test-worker",
      worktreePath,
      worktreeCleanupRequired: true,
    });

    expect(await jobs.releaseWorker(claimed!.id, "test-worker", claimed!.claimToken!)).toBe(false);
    const cleanup = await jobs.claimWorktreeCleanup(claimed!.id, "test-worker", claimed!.claimToken!, worktreePath);
    expect(cleanup).toMatchObject({ path: worktreePath });
    expect(await jobs.clearWorktree(claimed!.id, claimed!.claimToken!, cleanup!.cleanupToken)).toBe(true);
    expect(await jobs.releaseWorker(claimed!.id, "test-worker", claimed!.claimToken!)).toBe(true);

    expect(await jobs.requeueForRetry(claimed!.id, environment)).toMatchObject({
      id: claimed!.id,
      status: "QUEUED",
      worktreePath: null,
      sessionId: null,
    });
  });

  test("deduplicates PR jobs by repository, PR, head SHA, and job kind", async () => {
    const input = queuedPrJob("REVIEW", "c".repeat(40));
    const first = await jobs.tryCreateQueued(input);
    expect(first).not.toBeNull();
    expect(await jobs.tryCreateQueued(input)).toBeNull();
    expect(await jobs.tryCreateQueued(queuedPrJob("REVIEW", "d".repeat(40)))).not.toBeNull();
    expect(await jobs.tryCreateQueued(queuedPrJob("FIX", "d".repeat(40)))).not.toBeNull();
    expect(await jobs.tryCreateQueued(queuedPrJob("FIX", "d".repeat(40)))).toBeNull();

    expect(await jobs.cancel(first!.id)).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: first!.id } })).activePrKey).toBeNull();
    expect(await jobs.tryCreateQueued(input)).not.toBeNull();
    await prisma.job.deleteMany({ where: { environment, subjectType: "PULL_REQUEST" } });
  });

  test("reconciles cancelled reviews only for the worker environment", async () => {
    const local = await jobs.tryCreateQueued(queuedJob(issuePrefix + 60, environment));
    const foreign = await jobs.tryCreateQueued(queuedJob(issuePrefix + 61, `foreign-${crypto.randomUUID()}`));
    expect(local).not.toBeNull();
    expect(foreign).not.toBeNull();
    expect(await jobs.cancel(local!.id)).toBe(true);
    expect(await jobs.cancel(foreign!.id)).toBe(true);
    await prisma.review.createMany({
      data: [local!, foreign!].map((job) => ({
        jobId: job.id,
        provider: job.provider,
        model: job.model,
        status: "RUNNING" as const,
        startedAt: new Date(),
      })),
    });

    const { reviewRepository } = await import("../src/repositories/reviews.ts");
    expect(await reviewRepository.reconcileCancelledJobs(environment)).toBe(1);
    expect(await prisma.review.findUniqueOrThrow({ where: { jobId: local!.id } })).toMatchObject({ status: "FAILED" });
    expect(await prisma.review.findUniqueOrThrow({ where: { jobId: foreign!.id } })).toMatchObject({ status: "RUNNING" });
  });

  test("keeps quota-waiting jobs unique and requeues the same durable job", async () => {
    const input = queuedJob(issuePrefix + 10);
    const queued = await jobs.tryCreateQueued(input);
    expect(queued).not.toBeNull();
    expect(await jobs.waitForQuotaQueued(queued!.id, environment, {
      resetAt: "2026-08-29T21:00:00.000Z",
      window: "codex:primary",
      usedPercent: 100,
      message: "Codex quota exhausted",
    })).toBe(true);

    const waiting = await prisma.job.findUniqueOrThrow({ where: { id: queued!.id } });
    expect(waiting).toMatchObject({
      status: "WAITING_FOR_QUOTA",
      activeIssueKey: `${repositoryId}:${input.issueNumber}`,
      attempts: 0,
      quotaWindow: "codex:primary",
      quotaUsedPercent: 100,
    });
    expect(await jobs.tryCreateQueued(input)).toBeNull();
    expect((await jobs.findWaitingForQuota(environment)).map(({ id }) => id)).toContain(queued!.id);

    const requeued = await jobs.requeueWaitingForQuota(queued!.id, environment);
    expect(requeued?.id).toBe(queued!.id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: queued!.id } })).status).toBe("QUEUED");
    expect(await jobs.claim(queued!.id, environment, "test-worker")).not.toBeNull();
  });

  test("marks abandoned running jobs stale and never claims cancelled work", async () => {
    const stale = await jobs.tryCreateQueued(queuedJob(issuePrefix + 1));
    expect((await jobs.claim(stale!.id, environment, "dead-worker"))?.id).toBe(stale?.id);
    const activeStartedAt = new Date(Date.now() - 2_000);
    await prisma.job.update({
      where: { id: stale!.id },
      data: {
        heartbeatAt: new Date(Date.now() - 120_000),
        activeStartedAt,
        activeDurationMs: 700,
      },
    });

    const recovered = await jobs.recoverStaleBefore(environment, new Date(Date.now() - 60_000));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.repository.id).toBe(repositoryId);
    const staleRow = await prisma.job.findUniqueOrThrow({ where: { id: stale!.id } });
    expect(staleRow).toMatchObject({ status: "STALE", activeStartedAt: null });
    expect(staleRow.activeDurationMs).toBeGreaterThanOrEqual(2_700);
    expect(staleRow.durationMs).toBe(staleRow.activeDurationMs);

    const cancelled = await jobs.tryCreateQueued(queuedJob(issuePrefix + 2));
    expect(await jobs.cancel(cancelled!.id)).toBe(true);
    expect(await jobs.claim(cancelled!.id, environment, "test-worker")).toBeNull();
    expect(await jobs.complete(cancelled!.id, "stale-token", { outcome: "wrong" }, 0)).toBe(false);
  });

  test("rejects a stale worker result after the job is claimed again", async () => {
    const queued = await jobs.tryCreateQueued(queuedJob(issuePrefix + 5));
    const staleClaim = await jobs.claim(queued!.id, environment, "stale-worker");
    await prisma.job.update({
      where: { id: queued!.id },
      data: { heartbeatAt: new Date(Date.now() - 120_000) },
    });

    expect(await jobs.recoverStaleBefore(environment, new Date(Date.now() - 60_000))).toHaveLength(1);
    expect(await jobs.releaseWorker(queued!.id, "stale-worker", staleClaim!.claimToken!)).toBe(true);
    expect(await jobs.requeueForRetry(queued!.id, environment)).not.toBeNull();
    const currentClaim = await jobs.claim(queued!.id, environment, "replacement-worker");
    expect(currentClaim?.attempts).toBe((staleClaim?.attempts ?? 0) + 1);

    expect(await jobs.complete(queued!.id, staleClaim!.claimToken!, { outcome: "stale" }, 0)).toBe(false);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: queued!.id } })).status).toBe("RUNNING");
    expect(await jobs.complete(queued!.id, currentClaim!.claimToken!, { outcome: "current" }, 0)).toBe(true);
  });

  test("persists cumulative provider usage idempotently and stops updates after completion", async () => {
    const queued = await jobs.tryCreateQueued(queuedJob(issuePrefix + 4));
    const claimed = await jobs.claim(queued!.id, environment, "usage-worker");
    const first = {
      inputTokens: 1_000n,
      cachedInputTokens: 400n,
      outputTokens: 120n,
      reasoningOutputTokens: 80n,
      totalTokens: 1_120n,
    };

    expect(await jobs.setTokenUsage(claimed!.id, first, claimed!.claimToken!)).toBe(true);
    expect(await jobs.setTokenUsage(claimed!.id, first, claimed!.claimToken!)).toBe(true);
    expect(await jobs.setTokenUsage(claimed!.id, {
      inputTokens: 900n,
      cachedInputTokens: null,
      outputTokens: 100n,
      reasoningOutputTokens: null,
      totalTokens: 1_000n,
    }, claimed!.claimToken!)).toBe(true);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } })).toMatchObject(first);

    const int64Boundary = 2_147_483_648n;
    expect(await jobs.setTokenUsage(claimed!.id, {
      ...first,
      inputTokens: int64Boundary,
      totalTokens: int64Boundary,
    }, claimed!.claimToken!)).toBe(true);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } })).toMatchObject({
      ...first,
      inputTokens: int64Boundary,
      totalTokens: int64Boundary,
    });

    expect(await jobs.complete(claimed!.id, claimed!.claimToken!, { outcome: "complete" }, 0)).toBe(true);
    expect(await jobs.setTokenUsage(claimed!.id, {
      inputTokens: 2_000n,
      cachedInputTokens: 800n,
      outputTokens: 200n,
      reasoningOutputTokens: 100n,
      totalTokens: 2_200n,
    }, claimed!.claimToken!)).toBe(false);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } })).toMatchObject({
      ...first,
      inputTokens: int64Boundary,
      totalTokens: int64Boundary,
    });
  });

  test("stale recovery blocks an issue job while preserving unrelated labels", async () => {
    const { recoverStaleJobs } = await import("../src/worker/recovery.ts");
    const { createEventService } = await import("../src/events/service.ts");
    const stale = await jobs.tryCreateQueued(queuedJob(issuePrefix + 3, config.APP_ENV));
    await jobs.claim(stale!.id, config.APP_ENV, "dead-worker");
    await prisma.job.update({
      where: { id: stale!.id },
      data: { heartbeatAt: new Date(Date.now() - 120_000) },
    });
    const labelCalls: string[][] = [];
    const github = {
      getIssue: async () => ({ number: stale!.issueNumber, labels: ["bug", config.ISSUE_WORKING_LABEL] }),
      setIssueLabels: async (_repository: string, _issue: number, labels: string[]) => { labelCalls.push(labels); },
      addIssueComment: async () => {},
    };

    expect(await recoverStaleJobs(config, github as unknown as GitHubClient, createEventService())).toBe(1);
    expect(labelCalls[0]).toEqual(["bug", config.ISSUE_BLOCKED_LABEL]);
  });

  test("reconciles a cancelled quota worktree after the API handoff is interrupted", async () => {
    const queued = await jobs.tryCreateQueued(queuedJob(issuePrefix + 20, config.APP_ENV));
    expect(await jobs.waitForQuotaQueued(queued!.id, config.APP_ENV, {
      window: "codex:primary",
      usedPercent: 100,
      message: "Codex quota exhausted",
    })).toBe(true);
    const worktreePath = `/worker_data/worktrees/${crypto.randomUUID()}`;
    await prisma.job.update({ where: { id: queued!.id }, data: { worktreePath } });

    expect(await jobs.cancel(queued!.id)).toBe(true);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: queued!.id } })).toMatchObject({
      status: "CANCELLED",
      worktreeCleanupRequired: true,
    });

    const { createEventService } = await import("../src/events/service.ts");
    const removed: string[] = [];
    const { recoverCancelledWorktrees } = await import("../src/worktrees/recovery.ts");
    expect(await recoverCancelledWorktrees(
      config,
      createEventService(),
      async ({ worktreePath: path }) => { removed.push(path); },
    )).toBe(1);
    expect(removed).toEqual([worktreePath]);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: queued!.id } })).toMatchObject({
      worktreeCleanupRequired: false,
      worktreePath: null,
    });
  });

  test("recovers a cancelled running job after worker loss and allows the retry to complete", async () => {
    const queued = await jobs.tryCreateQueued(queuedJob(issuePrefix + 30, config.APP_ENV));
    const claimed = await jobs.claim(queued!.id, config.APP_ENV, "lost-worker");
    const worktreePath = `/worker_data/worktrees/${crypto.randomUUID()}`;
    await prisma.job.update({
      where: { id: claimed!.id },
      data: { worktreePath, sessionId: "cancelled-session" },
    });

    expect(await jobs.cancel(claimed!.id)).toBe(true);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } })).toMatchObject({
      status: "CANCELLED",
      workerId: "lost-worker",
      worktreePath,
      worktreeCleanupRequired: true,
      heartbeatAt: expect.any(Date),
    });

    const removed: string[] = [];
    const { recoverStaleJobs } = await import("../src/worker/recovery.ts");
    expect(await recoverStaleJobs(
      config,
      {} as GitHubClient,
      (await import("../src/events/service.ts")).createEventService(),
      async ({ worktreePath: path }) => { removed.push(path); },
    )).toBe(0);
    expect(removed).toEqual([]);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } })).workerId)
      .toBe("lost-worker");

    await prisma.job.update({
      where: { id: claimed!.id },
      data: { heartbeatAt: new Date(Date.now() - config.STALE_JOB_THRESHOLD_MS - 1_000) },
    });
    expect(await recoverStaleJobs(
      config,
      {} as GitHubClient,
      (await import("../src/events/service.ts")).createEventService(),
      async ({ worktreePath: path }) => { removed.push(path); },
    )).toBe(0);
    expect(removed).toEqual([worktreePath]);

    const retried = await jobs.requeueForRetry(claimed!.id, config.APP_ENV);
    expect(retried).toMatchObject({
      id: claimed!.id,
      status: "QUEUED",
      workerId: null,
      worktreePath: null,
      sessionId: null,
    });
    const reclaimed = await jobs.claim(claimed!.id, config.APP_ENV, "replacement-worker");
    expect(reclaimed?.workerId).toBe("replacement-worker");
    expect(await jobs.complete(claimed!.id, reclaimed!.claimToken!, { outcome: "retried" }, 0)).toBe(true);
  });

  test("reconciles a cancelled running worktree after its worker is lost", async () => {
    const queued = await jobs.tryCreateQueued(queuedJob(issuePrefix + 24, config.APP_ENV));
    const claimed = await jobs.claim(queued!.id, config.APP_ENV, "lost-worker");
    const worktreePath = `/worker_data/worktrees/${crypto.randomUUID()}`;
    await prisma.job.update({ where: { id: queued!.id }, data: { worktreePath } });

    expect(await jobs.cancel(queued!.id)).toBe(true);
    const removed: string[] = [];
    const { createEventService } = await import("../src/events/service.ts");
    const { recoverCancelledWorktrees } = await import("../src/worktrees/recovery.ts");
    expect(await recoverCancelledWorktrees(
      config,
      createEventService(),
      async ({ worktreePath: path }) => { removed.push(path); },
    )).toBe(0);

    expect(removed).toEqual([]);
    await prisma.$executeRaw`
      UPDATE "job"
      SET "heartbeatAt" = ${new Date(Date.now() - config.STALE_JOB_THRESHOLD_MS - 1)}
      WHERE "id" = ${queued!.id}
    `;
    expect(await recoverCancelledWorktrees(
      config,
      createEventService(),
      async ({ worktreePath: path }) => { removed.push(path); },
    )).toBe(1);

    expect(removed).toEqual([worktreePath]);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: queued!.id } })).toMatchObject({
      status: "CANCELLED",
      workerId: null,
      claimToken: null,
      worktreePath: null,
      worktreeCleanupRequired: false,
    });
    expect(await jobs.requeueForRetry(queued!.id, config.APP_ENV)).not.toBeNull();
    expect(claimed?.claimToken).toBeString();
  });

  function queuedJob(issueNumber: number, jobEnvironment = environment) {
    return {
      repositoryId,
      environment: jobEnvironment,
      jobType: "IMPLEMENTATION" as const,
      subjectType: "ISSUE" as const,
      issueNumber,
      issueTitle: `Issue ${issueNumber}`,
      issueUrl: `https://github.com/test/lifecycle/issues/${issueNumber}`,
      issueBody: "Acceptance criteria",
      branchName: `agent/issue-${issueNumber}`,
      baselineCommit: "a".repeat(40),
      provider: "CODEX" as const,
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
    };
  }

  function queuedPrJob(jobType: "REVIEW" | "FIX", headSha: string, jobEnvironment = environment) {
    return {
      repositoryId,
      environment: jobEnvironment,
      jobType,
      subjectType: "PULL_REQUEST" as const,
      issueNumber: issuePrefix,
      issueTitle: `Issue ${issuePrefix}`,
      issueUrl: `https://github.com/test/lifecycle/issues/${issuePrefix}`,
      issueBody: "Acceptance criteria",
      branchName: `agent/issue-${issuePrefix}`,
      baselineCommit: "a".repeat(40),
      pullRequestId: managedPrId,
      pullRequestNumber: 500,
      pullRequestUrl: "https://github.com/test/lifecycle/pull/500",
      headSha,
      provider: "CODEX" as const,
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
    };
  }
});

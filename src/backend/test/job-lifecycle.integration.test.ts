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

    expect(await jobs.complete(claimed!.id, { outcome: "implemented" }, 0)).toBe(true);
    expect(await jobs.complete(claimed!.id, { outcome: "duplicate" }, 0)).toBe(false);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } })).activeIssueKey)
      .toBeNull();
    const retry = await jobs.tryCreateQueued(input);
    expect(retry).not.toBeNull();
    expect(await jobs.cancel(retry!.id)).toBe(true);
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

    expect(await jobs.claim(claimed!.id, environment, "test-worker")).not.toBeNull();
    await prisma.job.update({ where: { id: claimed!.id }, data: { errorMessage: "stale retry error" } });
    expect(await jobs.complete(claimed!.id, { outcome: "implemented" }, 0)).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } })).errorMessage).toBeNull();
  });

  test("does not requeue a cancelled worker until its cleanup releases the retained worktree", async () => {
    const queued = await jobs.tryCreateQueued(queuedJob(issuePrefix + 21));
    const claimed = await jobs.claim(queued!.id, environment, "test-worker");
    const worktreePath = `/data/worktrees/${claimed!.id}`;
    await prisma.job.update({
      where: { id: claimed!.id },
      data: { worktreePath, sessionId: "cancelled-session" },
    });

    expect(await jobs.cancel(claimed!.id)).toBe(true);
    expect(await jobs.requeueForRetry(claimed!.id, environment)).toBeNull();
    expect(await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } })).toMatchObject({
      status: "CANCELLED",
      workerId: "test-worker",
      worktreePath,
    });

    expect(await jobs.releaseWorker(claimed!.id, "test-worker")).toBe(false);
    expect(await jobs.clearWorktree(claimed!.id)).toBe(true);
    expect(await jobs.releaseWorker(claimed!.id, "test-worker")).toBe(true);

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

  test("marks abandoned running jobs stale and never claims cancelled work", async () => {
    const stale = await jobs.tryCreateQueued(queuedJob(issuePrefix + 1));
    expect((await jobs.claim(stale!.id, environment, "dead-worker"))?.id).toBe(stale?.id);
    await prisma.job.update({
      where: { id: stale!.id },
      data: { heartbeatAt: new Date(Date.now() - 120_000) },
    });

    const recovered = await jobs.recoverStaleBefore(environment, new Date(Date.now() - 60_000));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.repository.id).toBe(repositoryId);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: stale!.id } })).status).toBe("STALE");

    const cancelled = await jobs.tryCreateQueued(queuedJob(issuePrefix + 2));
    expect(await jobs.cancel(cancelled!.id)).toBe(true);
    expect(await jobs.claim(cancelled!.id, environment, "test-worker")).toBeNull();
    expect(await jobs.complete(cancelled!.id, { outcome: "wrong" }, 0)).toBe(false);
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

  function queuedPrJob(jobType: "REVIEW" | "FIX", headSha: string) {
    return {
      repositoryId,
      environment,
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

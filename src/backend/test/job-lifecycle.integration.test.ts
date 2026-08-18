import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("PostgreSQL job lifecycle", () => {
  let prisma: typeof import("../src/core/db.ts").prisma;
  let jobs: typeof import("../src/repositories/jobs.ts").jobRepository;
  let repositoryId = "";
  const environment = `test-${crypto.randomUUID()}`;
  const issuePrefix = Math.floor(Math.random() * 100_000) + 100_000;

  beforeAll(async () => {
    ({ prisma } = await import("../src/core/db.ts"));
    ({ jobRepository: jobs } = await import("../src/repositories/jobs.ts"));
    repositoryId = (await prisma.repository.create({
      data: {
        fullName: `test/lifecycle-${crypto.randomUUID()}`,
        cloneUrl: "https://github.com/test/lifecycle.git",
      },
    })).id;
  });

  afterAll(async () => {
    await prisma.job.deleteMany({ where: { repositoryId } });
    await prisma.repository.delete({ where: { id: repositoryId } });
    await prisma.$disconnect();
  });

  test("claims once, guards completion, and releases the issue for a later retry", async () => {
    const input = queuedJob(issuePrefix);
    const queued = await jobs.tryCreateQueued(input);
    expect(queued?.status).toBe("QUEUED");
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

  test("defers a child as one blocked row, promotes it when released, and withdraws queued work", async () => {
    const issue = issuePrefix + 10;
    const parent = issue - 1;
    const dependencyBlock = {
      repositoryId,
      environment,
      issueNumber: issue,
      issueTitle: `Issue ${issue}`,
      issueUrl: `https://github.com/test/lifecycle/issues/${issue}`,
      issueBody: "Acceptance criteria",
      branchName: `agent/issue-${issue}`,
      baselineCommit: "a".repeat(40),
      provider: "CODEX" as const,
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      blockingIssueNumber: parent,
      blockingIssueUrl: `https://github.com/test/lifecycle/issues/${parent}`,
    };

    const blocked = await jobs.deferForDependency({ ...dependencyBlock, scanRunId: null });
    expect(blocked.job).toMatchObject({
      status: "BLOCKED",
      blockingIssueNumber: parent,
      errorMessage: `Blocked by parent issue #${parent}: https://github.com/test/lifecycle/issues/${parent}`,
    });
    expect(blocked.changed).toBe(true);
    expect(blocked.job!.activeIssueKey).toBe(`${repositoryId}:${issue}`);

    const repeated = await jobs.deferForDependency({ ...dependencyBlock, scanRunId: null });
    expect(repeated.changed).toBe(false);
    expect(repeated.job!.id).toBe(blocked.job!.id);
    expect(await prisma.job.count({ where: { repositoryId, issueNumber: issue } })).toBe(1);

    const promoted = await jobs.promoteBlocked(
      repositoryId,
      issue,
      environment,
      null,
      `agent/issue-${issue}-retry`,
      "b".repeat(40),
    );
    expect(promoted).toMatchObject({
      status: "QUEUED",
      blockingIssueNumber: null,
      blockingIssueUrl: null,
      branchName: `agent/issue-${issue}-retry`,
      baselineCommit: "b".repeat(40),
    });
    expect(promoted!.activeIssueKey).toBe(`${repositoryId}:${issue}`);

    const withdrawn = await jobs.deferForDependency({ ...dependencyBlock, scanRunId: null });
    expect(withdrawn.cancelledQueuedJobId).toBe(promoted!.queueJobId);
    expect(withdrawn.changed).toBe(true);
    expect(withdrawn.job).toMatchObject({ status: "BLOCKED", blockingIssueNumber: parent });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: promoted!.id } })).status).toBe("CANCELLED");

    await prisma.job.update({
      where: { id: withdrawn.job!.id },
      data: { status: "CANCELLED", activeIssueKey: null, completedAt: new Date() },
    });
  });

  function queuedJob(issueNumber: number) {
    return {
      repositoryId,
      environment,
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
});

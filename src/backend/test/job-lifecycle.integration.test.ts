import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config-schema.ts";
import type { GitHubClient } from "../src/github/client.ts";

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("PostgreSQL job lifecycle", () => {
  let prisma: typeof import("../src/core/db.ts").prisma;
  let jobs: typeof import("../src/repositories/jobs.ts").jobRepository;
  let repositoryId = "";
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

  test("stale recovery blocks the issue instead of leaving it untagged", async () => {
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
      getIssue: async () => ({
        number: stale!.issueNumber,
        labels: ["bug", config.ISSUE_WORKING_LABEL],
      }),
      setIssueLabels: async (_repository: string, _issue: number, labels: string[]) => {
        labelCalls.push(labels);
      },
      addIssueComment: async () => {},
    };

    expect(await recoverStaleJobs(config, github as unknown as GitHubClient, createEventService())).toBe(1);
    expect(labelCalls[0]).toEqual(["bug", config.ISSUE_BLOCKED_LABEL]);
  });

  function queuedJob(issueNumber: number, jobEnvironment = environment) {
    return {
      repositoryId,
      environment: jobEnvironment,
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

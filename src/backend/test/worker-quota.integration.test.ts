import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config-schema.ts";
import { createCodexUsageReader } from "../src/providers/codex-usage.ts";
import type { ProviderUsageSnapshot } from "../src/providers/types.ts";
import { queuePayload, type QueueProcessor } from "../src/queue/service.ts";

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("worker quota admission", () => {
  let prisma: typeof import("../src/core/db.ts").prisma;
  let jobs: typeof import("../src/repositories/jobs.ts").jobRepository;
  let repositoryId = "";
  const environment = "local";
  const config = parseConfig({
    APP_ENV: environment,
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused:unused@localhost:5432/unused",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:18422",
    SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY ?? "test-settings-encryption-key-0123456789",
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORIES: "acme/worker-quota",
    AGENT_PROVIDER: "codex",
    WORKER_ID: `quota-worker-${crypto.randomUUID()}`,
  });

  beforeAll(async () => {
    ({ prisma } = await import("../src/core/db.ts"));
    ({ jobRepository: jobs } = await import("../src/repositories/jobs.ts"));
    const repository = await prisma.repository.create({
      data: {
        fullName: `acme/worker-quota-${crypto.randomUUID()}`,
        cloneUrl: "https://github.com/acme/worker-quota.git",
      },
    });
    repositoryId = repository.id;
  });

  afterAll(async () => {
    await prisma.jobEvent.deleteMany({ where: { repositoryId } });
    await prisma.job.deleteMany({ where: { repositoryId } });
    await prisma.repository.delete({ where: { id: repositoryId } });
    await prisma.$disconnect();
  });

  test("defers every exhausted job before claim, without redundant account reads", async () => {
    const first = await jobs.tryCreateQueued(queuedJob(701));
    const second = await jobs.tryCreateQueued(queuedJob(702));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const exhausted: ProviderUsageSnapshot = {
      status: "available",
      availability: "exhausted",
      spendControlReached: null,
      rateLimitReachedType: null,
      observedAt: "2026-08-29T20:00:00.000Z",
      windows: [{
        limitId: "codex",
        limitName: "included",
        windowType: "primary",
        usedPercent: 100,
        remainingPercent: 0,
        windowDurationMins: 300,
        resetsAt: "2026-08-29T21:00:00.000Z",
      }],
    };
    let reads = 0;
    const usage = createCodexUsageReader({
      read: async () => {
        reads += 1;
        await Bun.sleep(1);
        return exhausted;
      },
    });
    let processor!: QueueProcessor;
    let runs = 0;
    const worker = { concurrency: 0, close: async () => {} };
    const queue = {
      createWorker(candidate: QueueProcessor) {
        processor = candidate;
        return worker;
      },
    };
    const recorded: Array<{ type: string }> = [];
    const { startWorkerLoops } = await import("../src/worker/service.ts");
    const loops = startWorkerLoops(
      config,
      queue as never,
      { run: async () => { runs += 1; return true; } },
      { reload: async () => {} } as never,
      undefined,
      { codex: usage },
      { record: async (event: { type: string }) => { recorded.push({ type: event.type }); return event as never; } } as never,
    );

    await Promise.all([
      processor(queuePayload(first!.id, environment)),
      processor(queuePayload(second!.id, environment)),
    ]);
    await loops.stop();

    expect(reads).toBe(1);
    expect(runs).toBe(0);
    expect(recorded.filter(({ type }) => type === "JOB_WAITING_FOR_QUOTA")).toHaveLength(2);
    expect(await prisma.job.findMany({
      where: { id: { in: [first!.id, second!.id] } },
      orderBy: { issueNumber: "asc" },
      select: { status: true, attempts: true, activeIssueKey: true, quotaWindow: true },
    })).toEqual([
      { status: "WAITING_FOR_QUOTA", attempts: 0, activeIssueKey: `${repositoryId}:701`, quotaWindow: "codex:primary" },
      { status: "WAITING_FOR_QUOTA", attempts: 0, activeIssueKey: `${repositoryId}:702`, quotaWindow: "codex:primary" },
    ]);
  });

  function queuedJob(issueNumber: number) {
    return {
      repositoryId,
      environment,
      jobType: "IMPLEMENTATION" as const,
      subjectType: "ISSUE" as const,
      issueNumber,
      issueTitle: `Issue ${issueNumber}`,
      issueUrl: `https://github.com/acme/worker-quota/issues/${issueNumber}`,
      issueBody: "Quota admission",
      branchName: `agent/issue-${issueNumber}`,
      baselineCommit: "a".repeat(40),
      provider: "CODEX" as const,
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
    };
  }
});

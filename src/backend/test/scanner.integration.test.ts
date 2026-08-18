import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseConfig } from "../src/core/config-schema.ts";
import { MissingDevelopBranchError } from "../src/git/repositories.ts";
import type { AgentProvider } from "../src/providers/index.ts";

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("repository scan", () => {
  let prisma: typeof import("../src/core/db.ts").prisma;
  let createScanService: typeof import("../src/scans/service.ts").createScanService;
  const environment = `scan-test-${crypto.randomUUID()}`;
  const barrierEnvironment = `scan-barrier-${crypto.randomUUID()}`;
  const labels: Array<{ repository: string; issue: number; labels: string[] }> = [];
  const enqueuedJobs: string[] = [];
  const removedJobs: string[] = [];
  let issueNumber = 42;
  let labelFailure = false;
  let firstScanId = "";
  let activeBranch = "";
  let parent: { number: number; state: "open" | "closed"; stateReason: string | null } | null = null;
  const config = parseConfig({
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused:unused@localhost:5432/unused",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:18422",
    SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY ?? "test-settings-encryption-key-0123456789",
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORIES: "acme/app,acme/main-only",
    AGENT_PROVIDER: "codex",
    APP_ENV: "test",
    AGENT_RUNTIME_DIR: resolve(import.meta.dir, "../../../agent-runtime"),
  });
  const github = {
    getRepository: async (fullName: string) => ({ cloneUrl: `https://github.com/${fullName}.git` }),
    listReadyIssues: async (fullName: string) => fullName === "acme/app" ? [{
      number: issueNumber,
      title: "Make the queue durable",
      body: "Use PostgreSQL",
      url: `https://github.com/acme/app/issues/${issueNumber}`,
      labels: ["bug", "agent:ready"],
    }] : [],
    setIssueLabels: async (repository: string, issue: number, nextLabels: string[]) => {
      if (labelFailure) throw new Error("GitHub labels unavailable");
      labels.push({ repository, issue, labels: nextLabels });
    },
    getParentIssue: async (_fullName: string, _issue: number) => parent
      ? {
        number: parent.number,
        title: "Prerequisite",
        url: `https://github.com/acme/app/issues/${parent.number}`,
        state: parent.state,
        stateReason: parent.stateReason,
      }
      : null,
    getIssue: async () => ({ number: issueNumber, title: "Issue", body: "", url: "https://github.com/acme/app/issues/1", labels: ["agent:working"] }),
    getPullRequest: async (_repository: string, number: number) => ({
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      base: "develop",
      head: activeBranch,
      body: `Closes #${issueNumber}`,
    }),
    getPullRequestDiff: async () => "diff --git a/src/a.ts b/src/a.ts",
    addIssueComment: async () => {},
  };
  const sync = async ({ fullName }: { fullName: string }) => {
    if (fullName === "acme/main-only") throw new MissingDevelopBranchError(fullName);
    return { localPath: `/data/repositories/${fullName}`, baselineCommit: "b".repeat(40) };
  };

  beforeAll(async () => {
    ({ prisma } = await import("../src/core/db.ts"));
    ({ createScanService } = await import("../src/scans/service.ts"));
    await prisma.job.deleteMany({ where: { environment } });
  });

  afterAll(async () => {
    const repositories = await prisma.repository.findMany({
      where: { fullName: { in: config.githubRepositories } },
      select: { id: true },
    });
    const repositoryIds = repositories.map(({ id }) => id);
    await prisma.jobEvent.deleteMany({ where: { repositoryId: { in: repositoryIds } } });
    await prisma.job.deleteMany({ where: { environment } });
    await prisma.scanRun.deleteMany({ where: { environment: { in: [environment, barrierEnvironment] } } });
    await prisma.repository.deleteMany({ where: { id: { in: repositoryIds } } });
    await prisma.$disconnect();
  });

  test("does not complete a scan before repository discovery closes", async () => {
    const { scanRunRepository } = await import("../src/repositories/scan-runs.ts");
    const scan = await scanRunRepository.start(barrierEnvironment, "MANUAL", 0);

    expect(await scanRunRepository.finishJobs(scan.id, barrierEnvironment)).toBeNull();
    await scanRunRepository.finishDiscovery(scan.id, 0);
    expect((await scanRunRepository.finishJobs(scan.id, barrierEnvironment))?.status).toBe("COMPLETED");
  });

  test("queues ready issues from origin/develop and records invalid repositories", async () => {
    const scanner = createScanService({
      config: { ...config, APP_ENV: environment as "test" },
      github,
      queue: {
        enqueue: async (jobId) => { enqueuedJobs.push(jobId); },
        remove: async (jobId) => { removedJobs.push(jobId); return true; },
      },
      syncRepository: sync,
    });
    const scan = await scanner.run("MANUAL");
    firstScanId = scan.id;

    expect(scan.status).toBe("RUNNING");
    expect(scan.queuedCount).toBe(1);
    expect(labels).toEqual([{
      repository: "acme/app",
      issue: 42,
      labels: ["bug", "agent:working"],
    }]);
    const job = await prisma.job.findFirstOrThrow({ where: { environment } });
    expect(enqueuedJobs).toEqual([job.id]);
    expect(job).toMatchObject({
      issueNumber: 42,
      issueBody: "Use PostgreSQL",
      baselineCommit: "b".repeat(40),
      provider: "CODEX",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      scanRunId: scan.id,
    });
    expect(await prisma.repository.findUniqueOrThrow({ where: { fullName: "acme/main-only" } }))
      .toMatchObject({ status: "INVALID", developAvailable: false });
    expect((await prisma.jobEvent.findMany({
      where: { scanRunId: scan.id },
      select: { type: true },
    })).map(({ type }) => type)).toEqual(expect.arrayContaining([
      "SCAN_STARTED",
      "JOB_QUEUED",
      "SCAN_DISCOVERY_COMPLETED",
    ]));
    expect(await prisma.jobEvent.findFirst({
      where: { repository: { fullName: "acme/main-only" }, type: "REPOSITORY_INVALID" },
    })).not.toBeNull();
  });

  test("a repeated scan is skipped while prior work is active", async () => {
    const scanner = createScanService({ config: { ...config, APP_ENV: environment as "test" }, github, syncRepository: sync });
    const scan = await scanner.run("MANUAL");

    expect(scan.status).toBe("SKIPPED");
    expect(scan.queuedCount).toBe(0);
    expect(await prisma.job.count({ where: { environment } })).toBe(1);
    const job = await prisma.job.findFirstOrThrow({ where: { environment } });
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "CANCELLED", activeIssueKey: null, completedAt: new Date() },
    });
    const { scanRunRepository } = await import("../src/repositories/scan-runs.ts");
    expect((await scanRunRepository.finishJobs(firstScanId, environment))?.status).toBe("COMPLETED");
  });

  test("a failed label acquisition releases the issue key and fails the queued row", async () => {
    issueNumber = 43;
    labelFailure = true;
    const scanner = createScanService({ config: { ...config, APP_ENV: environment as "test" }, github, syncRepository: sync });
    const scan = await scanner.run("MANUAL");

    expect(scan).toMatchObject({ status: "COMPLETED", queuedCount: 0, failureCount: 1 });
    expect(await prisma.job.findFirstOrThrow({ where: { environment, issueNumber: 43 } }))
      .toMatchObject({ status: "FAILED", activeIssueKey: null });
    expect(await prisma.jobEvent.findFirst({ where: { scanRunId: scan.id, type: "SCAN_COMPLETED" } }))
      .not.toBeNull();
    expect(await prisma.jobEvent.findFirst({ where: { scanRunId: scan.id, type: "SCAN_DISCOVERY_COMPLETED" } }))
      .toMatchObject({ metadata: { queuedCount: 0 } });
    labelFailure = false;
  });

  test("runs a discovered issue through implementation, independent review, and scan completion", async () => {
    issueNumber = 44;
    const scanner = createScanService({ config: { ...config, APP_ENV: environment as "test" }, github, syncRepository: sync });
    const scan = await scanner.run("MANUAL");
    const { jobRepository } = await import("../src/repositories/jobs.ts");
    const queued = await prisma.job.findFirstOrThrow({ where: { environment, issueNumber } });
    const job = await jobRepository.claim(queued.id, environment, "workflow-worker");
    expect(job).not.toBeNull();
    activeBranch = job!.branchName;
    let call = 0;
    const provider: AgentProvider = {
      name: "codex",
      execute: async (request) => {
        call += 1;
        const finalOutput = request.role === "reviewer"
          ? '{"verdict":"pass","summary":"Ready","findings":[]}'
          : JSON.stringify({
            outcome: "implemented",
            summary: "Implemented",
            tests: ["bun test"],
            commit: "abcdef1",
            pr: { number: 44, url: "https://github.com/acme/app/pull/44", base: "develop", head: activeBranch },
          });
        return { provider: "codex", sessionId: `session-${call}`, exitCode: 0, finalOutput, stderr: "" };
      },
    };
    const { createJobRunner } = await import("../src/runner/service.ts");
    const runner = createJobRunner({
      config: { ...config, APP_ENV: environment as "test" },
      provider,
      github,
      createWorktree: async (input) => input.worktreePath,
    });

    expect(await runner.run(job!.id, "workflow-worker")).toBe(true);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job!.id }, include: { review: true } }))
      .toMatchObject({ status: "COMPLETED", review: { status: "PASSED" } });
    expect(await prisma.scanRun.findUniqueOrThrow({ where: { id: scan.id } }))
      .toMatchObject({ status: "COMPLETED", successCount: 1, reviewsCount: 1 });
    expect(await prisma.jobEvent.findFirst({ where: { scanRunId: scan.id, type: "SCAN_COMPLETED" } }))
      .not.toBeNull();
  });

  test("defers a ready child while its parent is unresolved", async () => {
    issueNumber = 45;
    parent = { number: 44, state: "open", stateReason: null };
    const scanner = createScanService({ config: { ...config, APP_ENV: environment as "test" }, github, syncRepository: sync });
    const scan = await scanner.run("MANUAL");

    expect(scan).toMatchObject({ status: "COMPLETED", queuedCount: 0, blockedCount: 1 });
    const job = await prisma.job.findFirstOrThrow({ where: { environment, issueNumber: 45 } });
    expect(job).toMatchObject({
      status: "BLOCKED",
      blockingIssueNumber: 44,
      blockingIssueUrl: "https://github.com/acme/app/issues/44",
    });
    expect(job.activeIssueKey).toBe(`${job.repositoryId}:45`);
    expect(job.errorMessage).toContain("Blocked by parent issue #44");
    expect(enqueuedJobs).not.toContain(job.id);
    expect(await prisma.jobEvent.findFirst({ where: { scanRunId: scan.id, type: "JOB_DEFERRED" } }))
      .toMatchObject({ metadata: { blockingIssueNumber: 44 } });
  });

  test("promotes the deferred child once the parent is completed", async () => {
    const deferred = await prisma.job.findFirstOrThrow({ where: { environment, issueNumber: 45 } });
    parent = { number: 44, state: "closed", stateReason: "completed" };
    const scanner = createScanService({
      config: { ...config, APP_ENV: environment as "test" },
      github,
      queue: {
        enqueue: async (jobId) => { enqueuedJobs.push(jobId); },
        remove: async () => true,
      },
      syncRepository: sync,
    });
    const scan = await scanner.run("MANUAL");

    expect(scan).toMatchObject({ queuedCount: 1, status: "RUNNING" });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: deferred.id } });
    expect(job).toMatchObject({
      status: "QUEUED",
      blockingIssueNumber: null,
      blockingIssueUrl: null,
      scanRunId: scan.id,
    });
    expect(enqueuedJobs).toContain(job.id);

    await prisma.job.update({
      where: { id: job.id },
      data: { status: "CANCELLED", activeIssueKey: null, completedAt: new Date() },
    });
    const { scanRunRepository } = await import("../src/repositories/scan-runs.ts");
    expect((await scanRunRepository.finishJobs(scan.id, environment))?.status).toBe("COMPLETED");
  });

  test("withdraws a queued child when its parent is reopened before execution", async () => {
    issueNumber = 46;
    parent = null;
    const scanner = createScanService({ config: { ...config, APP_ENV: environment as "test" }, github, syncRepository: sync });
    const scan = await scanner.run("MANUAL");
    const queued = await prisma.job.findFirstOrThrow({ where: { environment, issueNumber: 46, status: "QUEUED" } });

    parent = { number: 44, state: "open", stateReason: null };
    const { createEventService } = await import("../src/events/service.ts");
    const { createDependencyGuard } = await import("../src/scans/dependencies.ts");
    const guard = createDependencyGuard(
      github,
      createEventService(),
      { remove: async (jobId) => { removedJobs.push(jobId); return true; } },
    );
    expect(await guard({ jobId: queued.id })).toBe(false);

    const withdrawn = await prisma.job.findUniqueOrThrow({ where: { id: queued.id } });
    expect(withdrawn.status).toBe("CANCELLED");
    expect(removedJobs).toContain(withdrawn.queueJobId);
    const deferred = await prisma.job.findFirstOrThrow({ where: { environment, issueNumber: 46, status: "BLOCKED" } });
    expect(deferred).toMatchObject({
      blockingIssueNumber: 44,
      blockingIssueUrl: "https://github.com/acme/app/issues/44",
    });
    expect(await prisma.jobEvent.findFirst({
      where: { jobId: deferred.id, type: "JOB_DEFERRED" },
    })).toMatchObject({ metadata: { withdrewQueued: true } });

    await prisma.job.update({
      where: { id: deferred.id },
      data: { status: "CANCELLED", activeIssueKey: null, completedAt: new Date() },
    });
    const { scanRunRepository } = await import("../src/repositories/scan-runs.ts");
    expect((await scanRunRepository.finishJobs(scan.id, environment))?.status).toBe("COMPLETED");
    parent = null;
  });
});

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
  const scannedLabels: string[] = [];
  let issueNumber = 42;
  let labelFailure = false;
  let freezeReadyList = false;
  const reviewRequestedIssues: Array<{ number: number; labels: string[] }> = [];
  let firstScanId = "";
  let activeBranch = "";
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
    listReadyIssues: async (fullName: string, label: string) => {
      scannedLabels.push(label);
      if (fullName !== "acme/app") return [];
      if (label === config.ISSUE_REVIEW_REQUESTED_LABEL) {
        return reviewRequestedIssues.map((issue) => ({
          number: issue.number,
          title: "Address the review",
          body: "A review requested changes",
          url: `https://github.com/acme/app/issues/${issue.number}`,
          labels: issue.labels,
        }));
      }
      if (label !== config.ISSUE_READY_LABEL || freezeReadyList) return [];
      return [{
        number: issueNumber,
        title: "Make the queue durable",
        body: "Use PostgreSQL",
        url: `https://github.com/acme/app/issues/${issueNumber}`,
        labels: ["bug", "agent:ready"],
      }];
    },
    setIssueLabels: async (repository: string, issue: number, nextLabels: string[]) => {
      if (labelFailure) throw new Error("GitHub labels unavailable");
      labels.push({ repository, issue, labels: nextLabels });
    },
    getIssue: async () => ({ number: issueNumber, title: "Issue", body: "", url: "https://github.com/acme/app/issues/1", labels: ["agent:working"] }),
    getPullRequest: async (_repository: string, number: number) => ({
      number,
      title: `Pull request ${number}`,
      url: `https://github.com/acme/app/pull/${number}`,
      base: "develop",
      head: activeBranch,
      body: `Closes #${issueNumber}`,
      additions: 12,
      deletions: 3,
      changedFiles: 2,
    }),
    getPullRequestDiff: async () => "diff --git a/src/a.ts b/src/a.ts",
    getIssueContext: async () => ({
      issue: { number: issueNumber, title: "Issue", body: "", url: `https://github.com/acme/app/issues/${issueNumber}`, labels: ["agent:working"] },
      issueComments: [],
      pullRequests: [],
    }),
    createIssue: async () => ({ number: issueNumber + 1000, url: `https://github.com/acme/app/issues/${issueNumber + 1000}` }),
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
      queue: { enqueue: async (jobId) => { enqueuedJobs.push(jobId); } },
      syncRepository: sync,
    });
    const scan = await scanner.run("MANUAL");
    firstScanId = scan.id;

    expect(scan.status).toBe("RUNNING");
    expect(scan.queuedCount).toBe(1);
    expect(scannedLabels).toEqual([config.ISSUE_READY_LABEL, config.ISSUE_REVIEW_REQUESTED_LABEL]);
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
          ? "Review: pass\nThe change is ready."
          : `Outcome: implemented\nPR: https://github.com/acme/app/pull/44\nImplemented the requested change.`;
        if (request.responseFilePath) await Bun.write(request.responseFilePath, finalOutput);
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

  test("acquiring a review retry keeps the review-requested label while working", async () => {
    freezeReadyList = true;
    reviewRequestedIssues.push({
      number: 45,
      labels: ["bug", config.ISSUE_REVIEW_REQUESTED_LABEL],
    });
    try {
      const scanner = createScanService({ config: { ...config, APP_ENV: environment as "test" }, github, syncRepository: sync });
      const scan = await scanner.run("MANUAL");
      expect(scan.queuedCount).toBe(1);
      expect(labels.at(-1)).toEqual({
        repository: "acme/app",
        issue: 45,
        labels: ["bug", config.ISSUE_REVIEW_REQUESTED_LABEL, config.ISSUE_WORKING_LABEL],
      });
      expect(await prisma.job.findFirstOrThrow({ where: { environment, issueNumber: 45 } }))
        .toMatchObject({ status: "QUEUED" });
    } finally {
      await prisma.job.deleteMany({ where: { environment, issueNumber: 45 } });
      reviewRequestedIssues.length = 0;
      freezeReadyList = false;
    }
  });
});

integration("aggregated queue notifications", () => {
  let prisma: typeof import("../src/core/db.ts").prisma;
  let createScanService: typeof import("../src/scans/service.ts").createScanService;
  let createEventService: typeof import("../src/events/service.ts").createEventService;
  const environment = `queue-summary-${crypto.randomUUID()}`;
  const repositories = ["acme/queue-summary"];
  let readyIssues: Array<{ number: number; title: string; body: string; url: string; labels: string[] }> = [];
  const config = parseConfig({
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused:unused@localhost:5432/unused",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:18422",
    SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY ?? "test-settings-encryption-key-0123456789",
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORIES: repositories.join(","),
    AGENT_PROVIDER: "codex",
    APP_ENV: "test",
    AGENT_RUNTIME_DIR: resolve(import.meta.dir, "../../../agent-runtime"),
  });
  const github = {
    getRepository: async (fullName: string) => ({ cloneUrl: `https://github.com/${fullName}.git` }),
    listReadyIssues: async (fullName: string, label: string) =>
      fullName === repositories[0] && label === config.ISSUE_READY_LABEL ? readyIssues : [],
    setIssueLabels: async () => {},
  };
  const sync = async () => ({ localPath: `/data/repositories/${repositories[0]}`, baselineCommit: "b".repeat(40) });

  beforeAll(async () => {
    ({ prisma } = await import("../src/core/db.ts"));
    ({ createScanService } = await import("../src/scans/service.ts"));
    ({ createEventService } = await import("../src/events/service.ts"));
    await prisma.job.deleteMany({ where: { environment } });
  });

  afterAll(async () => {
    const repositoryIds = (await prisma.repository.findMany({
      where: { fullName: { in: repositories } },
      select: { id: true },
    })).map(({ id }) => id);
    await prisma.jobEvent.deleteMany({ where: { repositoryId: { in: repositoryIds } } });
    await prisma.job.deleteMany({ where: { environment } });
    await prisma.scanRun.deleteMany({ where: { environment } });
    await prisma.repository.deleteMany({ where: { id: { in: repositoryIds } } });
    await prisma.$disconnect();
  });

  test("sends one queue summary instead of per-job or scan lifecycle notifications", async () => {
    readyIssues = [
      { number: 101, title: "Fix <alpha>", body: "Use SQL", url: "https://github.com/acme/queue-summary/issues/101", labels: ["agent:ready"] },
      { number: 102, title: "Fix beta", body: "Use SQL", url: "https://github.com/acme/queue-summary/issues/102", labels: ["agent:ready"] },
    ];
    const sent: string[] = [];
    const summaries: unknown[] = [];
    const events = createEventService({
      enabled: () => true,
      send: async (event) => { sent.push(event.type); },
      sendQueued: async (summary) => { summaries.push(summary); },
    });
    const scanner = createScanService({
      config: { ...config, APP_ENV: environment as "test" },
      github,
      events,
      queue: { enqueue: async () => {} },
      syncRepository: sync,
    });
    const scan = await scanner.run("MANUAL");

    expect(scan.queuedCount).toBe(2);
    expect(sent).toEqual([]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      scanRunId: scan.id,
      jobs: [
        { repository: "acme/queue-summary", issueNumber: 101, issueTitle: "Fix <alpha>", issueUrl: "https://github.com/acme/queue-summary/issues/101" },
        { repository: "acme/queue-summary", issueNumber: 102, issueTitle: "Fix beta", issueUrl: "https://github.com/acme/queue-summary/issues/102" },
      ],
    });
    const queued = await prisma.jobEvent.findMany({ where: { scanRunId: scan.id, type: "JOB_QUEUED" } });
    expect(queued).toHaveLength(2);
    expect(queued.every((event) => event.notifiedAt !== null)).toBe(true);
    for (const type of ["SCAN_STARTED", "SCAN_DISCOVERY_COMPLETED"]) {
      const lifecycle = await prisma.jobEvent.findFirst({ where: { scanRunId: scan.id, type } });
      expect(lifecycle).not.toBeNull();
      expect(lifecycle!.notifiedAt).toBeNull();
    }

    const queuedJobs = await prisma.job.findMany({ where: { scanRunId: scan.id } });
    await prisma.job.updateMany({
      where: { id: { in: queuedJobs.map((job) => job.id) } },
      data: { status: "CANCELLED", activeIssueKey: null, completedAt: new Date() },
    });
    const { scanRunRepository } = await import("../src/repositories/scan-runs.ts");
    expect((await scanRunRepository.finishJobs(scan.id, environment))?.status).toBe("COMPLETED");
  });

  test("sends no queue summary when a scan queues zero jobs", async () => {
    readyIssues = [];
    const sent: string[] = [];
    const summaries: unknown[] = [];
    const events = createEventService({
      enabled: () => true,
      send: async (event) => { sent.push(event.type); },
      sendQueued: async (summary) => { summaries.push(summary); },
    });
    const scanner = createScanService({
      config: { ...config, APP_ENV: environment as "test" },
      github,
      events,
      queue: { enqueue: async () => {} },
      syncRepository: sync,
    });
    const scan = await scanner.run("MANUAL");

    expect(scan.queuedCount).toBe(0);
    expect(sent).toEqual([]);
    expect(summaries).toEqual([]);
  });

  test("sends one queue summary when a scan queues a single job", async () => {
    readyIssues = [
      { number: 103, title: "Fix gamma", body: "Use SQL", url: "https://github.com/acme/queue-summary/issues/103", labels: ["agent:ready"] },
    ];
    const sent: string[] = [];
    const summaries: unknown[] = [];
    const events = createEventService({
      enabled: () => true,
      send: async (event) => { sent.push(event.type); },
      sendQueued: async (summary) => { summaries.push(summary); },
    });
    const scanner = createScanService({
      config: { ...config, APP_ENV: environment as "test" },
      github,
      events,
      queue: { enqueue: async () => {} },
      syncRepository: sync,
    });
    const scan = await scanner.run("MANUAL");

    expect(scan.queuedCount).toBe(1);
    expect(sent).toEqual([]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ jobs: [
      { repository: "acme/queue-summary", issueNumber: 103, issueTitle: "Fix gamma" },
    ] });
  });
});

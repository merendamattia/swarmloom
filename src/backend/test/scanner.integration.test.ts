import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseConfig } from "../src/core/config-schema.ts";
import { MissingDevelopBranchError } from "../src/git/repositories.ts";

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("issue scanner", () => {
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
    ensureLabels: async () => {},
    listReadyIssues: async (fullName: string, label: string) => {
      scannedLabels.push(label);
      if (fullName !== "acme/app" || label !== config.ISSUE_READY_LABEL || freezeReadyList) return [];
      return [{
        number: issueNumber,
        title: "Make the queue durable",
        body: "Use PostgreSQL",
        url: `https://github.com/acme/app/issues/${issueNumber}`,
        labels: ["bug", "agent:ready"],
      }];
    },
    listPullRequests: async () => [],
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
      head: "agent/issue-1",
      headSha: "a".repeat(40),
      state: "open",
      merged: false,
      body: `Closes #${issueNumber}`,
      additions: 12,
      deletions: 3,
      changedFiles: 2,
    }),
    getPullRequestLabels: async () => [],
    setPullRequestLabels: async () => {},
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
    await prisma.managedPullRequest.deleteMany({ where: { repositoryId: { in: repositoryIds } } });
    await prisma.job.deleteMany({ where: { environment } });
    await prisma.scanRun.deleteMany({ where: { environment: { in: [environment, barrierEnvironment] } } });
    await prisma.repository.deleteMany({ where: { id: { in: repositoryIds } } });
    await prisma.$disconnect();
  });

  test("completes after discovery and releases the environment lock", async () => {
    const { scanRunRepository } = await import("../src/repositories/scan-runs.ts");
    const scan = await scanRunRepository.start(barrierEnvironment, "MANUAL", 0);

    expect(scan.status).toBe("RUNNING");
    const completed = await scanRunRepository.finishDiscovery(scan.id, 0);
    expect(completed).toMatchObject({ status: "COMPLETED", activeEnvironmentKey: null });
    const next = await scanRunRepository.start(barrierEnvironment, "MANUAL", 0);
    expect(next.status).toBe("RUNNING");
    await scanRunRepository.finishDiscovery(next.id, 0);
  });

  test("queues ready issues as IMPLEMENTATION jobs from origin/develop and records invalid repositories", async () => {
    const scanner = createScanService({
      config: { ...config, APP_ENV: environment as "test" },
      github,
      queue: { enqueue: async (jobId) => { enqueuedJobs.push(jobId); } },
      syncRepository: sync,
    });
    const scan = await scanner.run("MANUAL");
    expect(scan.status).toBe("COMPLETED");
    expect(scan.queuedCount).toBe(1);
    expect(scannedLabels).toEqual([config.ISSUE_READY_LABEL]);
    expect(labels).toEqual([{
      repository: "acme/app",
      issue: 42,
      labels: ["bug", "agent:working"],
    }]);
    const job = await prisma.job.findFirstOrThrow({ where: { environment } });
    expect(enqueuedJobs).toEqual([job.id]);
    expect(job).toMatchObject({
      jobType: "IMPLEMENTATION",
      subjectType: "ISSUE",
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

  test("a repeated scan discovers while prior work is active without duplicating it", async () => {
    const scanner = createScanService({ config: { ...config, APP_ENV: environment as "test" }, github, syncRepository: sync });
    const scan = await scanner.run("MANUAL");

    expect(scan.status).toBe("COMPLETED");
    expect(scan.queuedCount).toBe(0);
    expect(await prisma.job.count({ where: { environment } })).toBe(1);
    const job = await prisma.job.findFirstOrThrow({ where: { environment } });
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "CANCELLED", activeIssueKey: null, completedAt: new Date() },
    });
  });

  test("a failed label acquisition releases the issue key and fails the queued row", async () => {
    issueNumber = 43;
    labelFailure = true;
    const scanner = createScanService({ config: { ...config, APP_ENV: environment as "test" }, github, syncRepository: sync });
    const scan = await scanner.run("MANUAL");

    expect(scan).toMatchObject({ status: "COMPLETED", queuedCount: 0 });
    expect(await prisma.job.findFirstOrThrow({ where: { environment, issueNumber: 43 } }))
      .toMatchObject({ status: "FAILED", activeIssueKey: null });
    expect(await prisma.jobEvent.findFirst({ where: { scanRunId: scan.id, type: "SCAN_DISCOVERY_COMPLETED" } }))
      .not.toBeNull();
    labelFailure = false;
  });
});

integration("pull request scanner", () => {
  let prisma: typeof import("../src/core/db.ts").prisma;
  let createScanService: typeof import("../src/scans/service.ts").createScanService;
  const environment = `pr-scan-${crypto.randomUUID()}`;
  const config = parseConfig({
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused:unused@localhost:5432/unused",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:18422",
    SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY ?? "test-settings-encryption-key-0123456789",
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORIES: "acme/app",
    AGENT_PROVIDER: "codex",
    APP_ENV: "test",
    AGENT_RUNTIME_DIR: resolve(import.meta.dir, "../../../agent-runtime"),
  });
  const enqueuedJobs: string[] = [];
  let repositoryId = "";
  let managedPrId = "";
  const prNumber = 77;
  const issueNumber = 55;
  const firstSha = "a".repeat(40);
  const secondSha = "b".repeat(40);
  let prState: { state: string; merged: boolean; headSha: string; head: string } = { state: "open", merged: false, headSha: firstSha, head: "agent/issue-55" };
  let prLabels: string[] = [];
  let discoveredPullRequests: Array<{ number: number; title: string; body: string; url: string; labels: string[] }> = [];
  let issueLabels: string[] = ["agent:working"];
  const scanOrder: string[] = [];
  const prLabelWrites: string[][] = [];
  const scanServiceConfig = () => createScanService({
    config: { ...config, APP_ENV: environment as "test" },
    github,
    queue: { enqueue: async (jobId) => { enqueuedJobs.push(jobId); } },
    syncRepository: async ({ fullName }) => ({ localPath: `/data/repositories/${fullName}`, baselineCommit: firstSha }),
  });
  const github = {
    getRepository: async (fullName: string) => ({ cloneUrl: `https://github.com/${fullName}.git` }),
    ensureLabels: async () => {},
    listReadyIssues: async () => { scanOrder.push("issues"); return []; },
    listPullRequests: async () => [...discoveredPullRequests],
    setIssueLabels: async (_repository: string, _issue: number, next: string[]) => { issueLabels = [...next]; },
    getIssue: async () => ({ number: issueNumber, title: "Issue", body: "", url: `https://github.com/acme/app/issues/${issueNumber}`, labels: [...issueLabels] }),
    getPullRequest: async (_fullName: string, number: number) => {
      scanOrder.push("pull-requests");
      return {
        number,
        title: `Pull request ${number}`,
        url: `https://github.com/acme/app/pull/${number}`,
        base: "develop",
        head: prState.head,
        headSha: prState.headSha,
        state: prState.state,
        merged: prState.merged,
        body: `Closes #${issueNumber}`,
        additions: 12,
        deletions: 3,
        changedFiles: 2,
      };
    },
    getPullRequestLabels: async () => [...prLabels],
    setPullRequestLabels: async (_fullName: string, _number: number, next: string[]) => {
      prLabelWrites.push(next);
      prLabels = [...next];
    },
    getPullRequestDiff: async () => "",
    getIssueContext: async () => ({ issue: await github.getIssue(), issueComments: [], pullRequests: [] }),
    createIssue: async () => ({ number: 1, url: "" }),
    addIssueComment: async () => {},
  };

  beforeAll(async () => {
    ({ prisma } = await import("../src/core/db.ts"));
    ({ createScanService } = await import("../src/scans/service.ts"));
    await prisma.job.deleteMany({ where: { environment } });
    const repository = await prisma.repository.create({
      data: {
        fullName: "acme/app",
        cloneUrl: "https://github.com/acme/app.git",
        localPath: "/data/repositories/acme/app",
        status: "READY",
        developAvailable: true,
        baselineCommit: firstSha,
      },
    });
    repositoryId = repository.id;
  });

  afterAll(async () => {
    await prisma.jobEvent.deleteMany({ where: { repositoryId } });
    await prisma.job.deleteMany({ where: { environment } });
    await prisma.managedPullRequest.deleteMany({ where: { repositoryId } });
    await prisma.scanRun.deleteMany({ where: { environment } });
    await prisma.repository.delete({ where: { id: repositoryId } });
    await prisma.$disconnect();
  });

  async function releaseScans() {
    await prisma.scanRun.updateMany({
      where: { environment },
      data: { status: "COMPLETED", activeEnvironmentKey: null, completedAt: new Date() },
    });
  }

  async function seedManagedPullRequest(overrides: Record<string, unknown> = {}) {
    const row = await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber,
        issueNumber,
        issueTitle: "Issue 55",
        issueUrl: `https://github.com/acme/app/issues/${issueNumber}`,
        headBranch: "agent/issue-55",
        headSha: firstSha,
        baseBranch: "develop",
        state: "OPEN",
        ...overrides,
      },
    });
    managedPrId = row.id;
    return row;
  }

  test("review cron runs before issue discovery and queues REVIEW without the Checks API", async () => {
    prState = { state: "open", merged: false, headSha: firstSha, head: "agent/issue-55" };
    prLabels = [config.PR_REVIEW_REQUESTED_LABEL];
    await seedManagedPullRequest({ workflow: "REVIEW_REQUESTED" });
    const scan = await scanServiceConfig().run("MANUAL");

    expect(scan.queuedCount).toBe(1);
    expect(scanOrder.slice(0, 2)).toEqual(["pull-requests", "issues"]);
    const job = await prisma.job.findFirstOrThrow({ where: { environment } });
    expect(job).toMatchObject({ jobType: "REVIEW", subjectType: "PULL_REQUEST", headSha: firstSha, trigger: "PR_REVIEW_REQUESTED" });
    expect(enqueuedJobs).toEqual([job.id]);
    expect(prLabels).toEqual([config.PR_REVIEW_REQUESTED_LABEL]);
  });

  test("imports a labeled open PR before reconciling it", async () => {
    await prisma.job.deleteMany({ where: { environment } });
    await prisma.managedPullRequest.deleteMany({ where: { repositoryId } });
    await releaseScans();
    enqueuedJobs.length = 0;
    scanOrder.length = 0;
    prState = { state: "open", merged: false, headSha: firstSha, head: "agent/issue-55" };
    prLabels = [config.PR_REVIEW_REQUESTED_LABEL];
    discoveredPullRequests = [{
      number: prNumber,
      title: "Pull request 77",
      body: "Closes #55",
      url: `https://github.com/acme/app/pull/${prNumber}`,
      labels: [config.PR_REVIEW_REQUESTED_LABEL],
    }];

    const scan = await scanServiceConfig().run("MANUAL");

    expect(scan.queuedCount).toBe(1);
    const imported = await prisma.managedPullRequest.findUniqueOrThrow({ where: { repositoryId_prNumber: { repositoryId, prNumber } } });
    managedPrId = imported.id;
    expect(imported).toMatchObject({ issueNumber, headBranch: "agent/issue-55", headSha: firstSha, workflow: "REVIEW_REQUESTED" });
    expect(await prisma.job.findFirstOrThrow({ where: { environment } }))
      .toMatchObject({ jobType: "REVIEW", subjectType: "PULL_REQUEST", pullRequestNumber: prNumber, headSha: firstSha });
    discoveredPullRequests = [];
  });

  test("duplicate review scans create exactly one REVIEW for the current head SHA", async () => {
    const scan = await scanServiceConfig().run("MANUAL");

    expect(scan.queuedCount).toBe(0);
    const job = await prisma.job.findFirstOrThrow({ where: { environment } });
    expect(job).toMatchObject({
      jobType: "REVIEW",
      subjectType: "PULL_REQUEST",
      pullRequestId: managedPrId,
      pullRequestNumber: prNumber,
      headSha: firstSha,
      issueNumber,
    });
    expect(await prisma.job.count({ where: { environment } })).toBe(1);
  });

  test("repairs a persisted implementation PR that is missing its review label", async () => {
    await prisma.job.deleteMany({ where: { environment } });
    await releaseScans();
    enqueuedJobs.length = 0;
    prLabels = ["feature"];
    await prisma.managedPullRequest.update({
      where: { id: managedPrId },
      data: { workflow: "NONE", implementationJobId: crypto.randomUUID() },
    });

    const scan = await scanServiceConfig().run("MANUAL");

    expect(scan.queuedCount).toBe(1);
    expect(prLabels).toEqual(["feature", config.PR_REVIEW_REQUESTED_LABEL]);
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { id: managedPrId } }))
      .toMatchObject({ workflow: "REVIEW_REQUESTED" });
    expect(await prisma.job.findFirstOrThrow({ where: { environment } }))
      .toMatchObject({ jobType: "REVIEW", headSha: firstSha });
  });

  test("an old head SHA can never trigger work for a newer SHA", async () => {
    await prisma.job.deleteMany({ where: { environment } });
    await releaseScans();
    enqueuedJobs.length = 0;
    prState = { state: "open", merged: false, headSha: secondSha, head: "agent/issue-55" };
    prLabels = [config.PR_REVIEW_REQUESTED_LABEL];
    await prisma.managedPullRequest.update({ where: { id: managedPrId }, data: { headSha: firstSha, workflow: "REVIEW_REQUESTED" } });
    const scan = await scanServiceConfig().run("MANUAL");

    const job = await prisma.job.findFirstOrThrow({ where: { environment } });
    expect(job.headSha).toBe(secondSha);
    expect(scan.queuedCount).toBe(1);
  });

  test("fix-requested creates a FIX job carrying the stored reason and preserves unrelated PR labels", async () => {
    await prisma.job.deleteMany({ where: { environment } });
    await releaseScans();
    enqueuedJobs.length = 0;
    prState = { state: "open", merged: false, headSha: secondSha, head: "agent/issue-55" };
    prLabels = ["feature", config.PR_FIX_REQUESTED_LABEL];
    await prisma.managedPullRequest.update({
      where: { id: managedPrId },
      data: { headSha: secondSha, workflow: "FIX_REQUESTED", fixReason: "REVIEW_CHANGES_REQUESTED", fixDetails: "Add a guard." },
    });
    const scan = await scanServiceConfig().run("MANUAL");

    expect(scan.queuedCount).toBe(1);
    const job = await prisma.job.findFirstOrThrow({ where: { environment } });
    expect(job).toMatchObject({ jobType: "FIX", trigger: "REVIEW_CHANGES_REQUESTED", headSha: secondSha });
    expect(prLabels).toEqual(["feature", config.PR_FIX_REQUESTED_LABEL]);
  });

  test("review-passed waits for the human merge without creating jobs", async () => {
    await prisma.job.deleteMany({ where: { environment } });
    await releaseScans();
    enqueuedJobs.length = 0;
    prLabels = [config.PR_REVIEW_PASSED_LABEL];
    await prisma.managedPullRequest.update({ where: { id: managedPrId }, data: { workflow: "REVIEW_PASSED" } });
    const scan = await scanServiceConfig().run("MANUAL");

    expect(scan.queuedCount).toBe(0);
    expect(enqueuedJobs).toEqual([]);
    expect(await prisma.job.count({ where: { environment } })).toBe(0);
  });

  test("a human merge finalizes the originating issue with the done label", async () => {
    await releaseScans();
    prState = { state: "closed", merged: true, headSha: secondSha, head: "agent/issue-55" };
    const scan = await scanServiceConfig().run("MANUAL");

    expect(scan.queuedCount).toBe(0);
    expect(issueLabels).toEqual([config.ISSUE_COMPLETED_LABEL]);
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { id: managedPrId } }))
      .toMatchObject({ state: "MERGED" });
    expect(await prisma.jobEvent.findFirst({ where: { repositoryId, type: "ISSUE_DONE" } })).not.toBeNull();
  });

  test("a blocked PR is unblocked with a fresh cycle budget when a human re-adds fix-requested", async () => {
    await releaseScans();
    prState = { state: "open", merged: false, headSha: secondSha, head: "agent/issue-55" };
    prLabels = [config.PR_FIX_REQUESTED_LABEL];
    await prisma.managedPullRequest.update({
      where: { id: managedPrId },
      data: { state: "OPEN", blocked: true, fixCycleCount: 9, workflow: "FIX_REQUESTED", fixReason: "REVIEW_CHANGES_REQUESTED" },
    });
    const scan = await scanServiceConfig().run("MANUAL");

    expect(scan.queuedCount).toBe(1);
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { id: managedPrId } }))
      .toMatchObject({ blocked: false, fixCycleCount: 0 });
  });

  test("a closed unmerged pull request is recorded without touching the issue", async () => {
    await prisma.job.deleteMany({ where: { environment } });
    await releaseScans();
    issueLabels = ["agent:working"];
    prState = { state: "closed", merged: false, headSha: secondSha, head: "agent/issue-55" };
    const scan = await scanServiceConfig().run("MANUAL");

    expect(scan.queuedCount).toBe(0);
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { id: managedPrId } }))
      .toMatchObject({ state: "CLOSED" });
    expect(issueLabels).toEqual(["agent:working"]);
    expect(await prisma.jobEvent.findFirst({ where: { repositoryId, type: "PULL_REQUEST_CLOSED" } })).not.toBeNull();
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
    ensureLabels: async () => {},
    listReadyIssues: async (fullName: string, label: string) =>
      fullName === repositories[0] && label === config.ISSUE_READY_LABEL ? readyIssues : [],
    listPullRequests: async () => [],
    setIssueLabels: async () => {},
    getIssue: async () => ({ number: 1, title: "Issue", body: "", url: "", labels: [] }),
    addIssueComment: async () => {},
    getPullRequest: async () => ({ number: 1, title: "PR", url: "", base: "develop", head: "agent/x", headSha: "a".repeat(40), state: "open", merged: false, body: "", additions: 0, deletions: 0, changedFiles: 0 }),
    getPullRequestLabels: async () => [],
    setPullRequestLabels: async () => {},
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
        { repository: "acme/queue-summary", issueNumber: 101, jobType: "IMPLEMENTATION", issueUrl: "https://github.com/acme/queue-summary/issues/101" },
        { repository: "acme/queue-summary", issueNumber: 102, issueTitle: "Fix beta", jobType: "IMPLEMENTATION" },
      ],
    });
    const queued = await prisma.jobEvent.findMany({ where: { scanRunId: scan.id, type: "JOB_QUEUED" } });
    expect(queued).toHaveLength(2);
    expect(queued.every((event) => event.notifiedAt !== null)).toBe(true);

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
});

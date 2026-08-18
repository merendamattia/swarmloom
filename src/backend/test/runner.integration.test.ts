import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseConfig } from "../src/core/config-schema.ts";
import type { AgentProvider, AgentRequest, AgentResult } from "../src/providers/index.ts";

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("job runner", () => {
  let prisma: typeof import("../src/core/db.ts").prisma;
  let jobs: typeof import("../src/repositories/jobs.ts").jobRepository;
  let createJobRunner: typeof import("../src/runner/service.ts").createJobRunner;
  let repositoryId = "";
  const environment = `runner-${crypto.randomUUID()}`;
  const issueBase = Math.floor(Math.random() * 100_000) + 300_000;
  const config = parseConfig({
    APP_ENV: "test",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused:unused@localhost:5432/unused",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:18422",
    SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY ?? "test-settings-encryption-key-0123456789",
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORIES: "acme/runner",
    AGENT_PROVIDER: "codex",
    AGENT_RUNTIME_DIR: resolve(import.meta.dir, "../../../agent-runtime"),
  });

  beforeAll(async () => {
    ({ prisma } = await import("../src/core/db.ts"));
    ({ jobRepository: jobs } = await import("../src/repositories/jobs.ts"));
    ({ createJobRunner } = await import("../src/runner/service.ts"));
    repositoryId = (await prisma.repository.create({
      data: {
        fullName: `acme/runner-${crypto.randomUUID()}`,
        cloneUrl: "https://github.com/acme/runner.git",
        localPath: "/tmp/fake-repository",
        status: "READY",
        developAvailable: true,
      },
    })).id;
  });

  afterAll(async () => {
    await prisma.jobEvent.deleteMany({ where: { repositoryId } });
    await prisma.job.deleteMany({ where: { repositoryId } });
    await prisma.repository.delete({ where: { id: repositoryId } });
    await prisma.$disconnect();
  });

  test("completes implementation and records independent pass/changes-requested reviews", async () => {
    for (const [offset, verdict] of [[0, "pass"], [1, "changes_requested"]] as const) {
      const job = await claimed(issueBase + offset);
      const implementationResponse = [
        `Outcome: implemented`,
        `PR: https://github.com/acme/runner/pull/${job.issueNumber}`,
        `Implemented the requested change and ran the checks.`,
      ].join("\n");
      const provider = new FakeProvider([
        success(implementationResponse, `implementation-${offset}`),
        success(`Review: ${verdict}\nThe change is ${verdict === "pass" ? "ready" : "not ready yet"}.\n${verdict === "changes_requested" ? "Add a guard." : ""}`.trim(), `review-${offset}`),
      ]);
      const github = fakeGitHub(job.issueNumber, job.branchName);
      const runner = createJobRunner({
        config,
        provider,
        github,
        createWorktree: async (input) => input.worktreePath,
      });

      expect(await runner.run(job.id, "runner-worker")).toBe(true);
      const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id }, include: { review: true } });
      expect(stored.status).toBe("COMPLETED");
      expect(stored.pullRequestNumber).toBe(job.issueNumber);
      expect(stored.pullRequestUrl).toBe(`https://github.com/acme/runner/pull/${job.issueNumber}`);
      expect(stored.result).toBe(implementationResponse);
      expect(stored.review?.status).toBe(verdict === "pass" ? "PASSED" : "CHANGES_REQUESTED");
      expect(stored.review?.response).toContain(`Review: ${verdict}`);
      expect(provider.calls.map((call) => call.role)).toEqual(["issue-worker", "reviewer"]);
      expect(new Set(provider.calls.map((call) => call.signal)).size).toBe(1);
      expect(provider.calls[0]?.context).toContain("Live GitHub context fetched before execution");
      expect(github.labels).toContain(
        verdict === "pass" ? config.ISSUE_COMPLETED_LABEL : config.ISSUE_REVIEW_REQUESTED_LABEL,
      );
      expect(github.comments.some((comment) => comment.issue === job.issueNumber && comment.body === implementationResponse))
        .toBe(true);
      expect(github.comments.some((comment) => comment.issue === job.issueNumber && comment.body.includes(`Review: ${verdict}`)))
        .toBe(true);
      expect(await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "PR_OPENED" } }))
        .toMatchObject({
          metadata: {
            pullRequestUrl: `https://github.com/acme/runner/pull/${job.issueNumber}`,
            pullRequestTitle: `Pull request ${job.issueNumber}`,
            pullRequestBody: `Closes #${job.issueNumber}`,
            additions: 12,
            deletions: 3,
            filesChanged: 2,
          },
        });
    }
  });

  test("uses a fresh decomposer session and records native child references", async () => {
    const job = await claimed(issueBase + 2);
    const provider = new FakeProvider([
      success("Outcome: requires_decomposition\nToo broad to fit one PR.", "triage"),
      success("Outcome: decomposed\nSplit into two children.", "decomposer"),
    ]);
    const github = fakeGitHub(job.issueNumber, job.branchName);
    const runner = createJobRunner({ config, provider, github, createWorktree: async (input) => input.worktreePath });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("DECOMPOSED");
    expect(provider.calls.map((call) => call.role)).toEqual(["issue-worker", "decomposer"]);
    expect(provider.sessions).toEqual(["triage", "decomposer"]);
    expect(provider.calls[1]?.context).toContain(`Queue-ready label for actionable children: ${config.ISSUE_READY_LABEL}`);
    expect(provider.calls[1]?.responseFilePath).toEndWith(`${job.id}-decomposer.txt`);
    expect(github.labels).toContain(config.ISSUE_DECOMPOSED_LABEL);
  });

  test("records blocked and failed outcomes without leaving an active issue key", async () => {
    const blocked = await claimed(issueBase + 3);
    const blockedGitHub = fakeGitHub(blocked.issueNumber, blocked.branchName);
    const blockedRunner = createJobRunner({
      config,
      provider: new FakeProvider([success("Outcome: blocked\nNeed the response contract.", "blocked")]),
      github: blockedGitHub,
      createWorktree: async (input) => input.worktreePath,
    });
    expect(await blockedRunner.run(blocked.id, "runner-worker")).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: blocked.id } })).status).toBe("BLOCKED");
    expect(blockedGitHub.labels).toContain(config.ISSUE_BLOCKED_LABEL);
    expect(blockedGitHub.labels).toContain(config.ISSUE_HUMAN_REVIEW_LABEL);

    const failed = await claimed(issueBase + 4);
    const failedGitHub = fakeGitHub(failed.issueNumber, failed.branchName);
    const failedRunner = createJobRunner({
      config,
      provider: new FakeProvider([{ ...success("", "failed"), exitCode: 2, stderr: "provider failed" }]),
      github: failedGitHub,
      createWorktree: async (input) => input.worktreePath,
    });
    expect(await failedRunner.run(failed.id, "runner-worker")).toBe(true);
    const failedStored = await prisma.job.findUniqueOrThrow({ where: { id: failed.id } });
    expect(failedStored.status).toBe("FAILED");
    expect(failedStored.activeIssueKey).toBeNull();
    expect(failedStored.errorMessage).toContain("provider failed");
    expect(failedGitHub.createdIssues[0]?.labels).toEqual([config.ISSUE_READY_LABEL]);
    expect(failedGitHub.createdIssues[0]?.body).toContain("Stack trace:");
  });

  test("aborts an active provider when cancellation makes its heartbeat fail", async () => {
    const job = await claimed(issueBase + 5);
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const provider: AgentProvider = {
      name: "codex",
      execute: async (request) => {
        started();
        await new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true }));
        throw new Error("unreachable");
      },
    };
    const runner = createJobRunner({
      config,
      provider,
      github: fakeGitHub(job.issueNumber, job.branchName),
      createWorktree: async (input) => input.worktreePath,
      heartbeatIntervalMs: 10,
    });
    const running = runner.run(job.id, "runner-worker");
    await didStart;
    expect(await jobs.cancel(job.id)).toBe(true);
    expect(await running).toBe(false);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("CANCELLED");
  });

  test("fails with a clear message when the agent finishes without writing the response", async () => {
    const job = await claimed(issueBase + 6);
    const provider: AgentProvider = {
      name: "opencode",
      execute: async () => ({ provider: "opencode", sessionId: "session-missing", exitCode: 0, finalOutput: "", stderr: "" }),
    };
    const runner = createJobRunner({
      config,
      provider,
      github: fakeGitHub(job.issueNumber, job.branchName),
      createWorktree: async (input) => input.worktreePath,
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("FAILED");
    expect(stored.errorMessage).toContain("without writing the response");
  });

  test("retries the role when the first response file lacks a recognized outcome marker", async () => {
    const job = await claimed(issueBase + 9);
    const github = fakeGitHub(job.issueNumber, job.branchName);
    const implementationResponse = [
      "Outcome: implemented",
      `PR: https://github.com/acme/runner/pull/${job.issueNumber}`,
      "Fixed on the second attempt.",
    ].join("\n");
    const provider = new FakeProvider([
      success("Implemented the requested change and ran the checks.", "implementation-malformed"),
      success(implementationResponse, "implementation-retry"),
      success("Review: pass\nLooks good.", "review-retry"),
    ]);
    const runner = createJobRunner({
      config,
      provider,
      github,
      createWorktree: async (input) => input.worktreePath,
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("COMPLETED");
    expect(provider.calls.map((call) => call.role)).toEqual(["issue-worker", "issue-worker", "reviewer"]);
    expect(provider.calls[1]?.context).toContain("Agent response must start with");
  });

  test("retries the reviewer with review guidance when its first response lacks a Review marker", async () => {
    const job = await claimed(issueBase + 10);
    const github = fakeGitHub(job.issueNumber, job.branchName);
    const implementationResponse = [
      "Outcome: implemented",
      `PR: https://github.com/acme/runner/pull/${job.issueNumber}`,
      "Implemented the requested change and ran the checks.",
    ].join("\n");
    const provider = new FakeProvider([
      success(implementationResponse, "implementation-reviewer-retry"),
      success("Outcome: implemented\nThe change is ready.", "review-malformed"),
      success("Review: pass\nLooks good.", "review-retry-2"),
    ]);
    const runner = createJobRunner({
      config,
      provider,
      github,
      createWorktree: async (input) => input.worktreePath,
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id }, include: { review: true } });
    expect(stored.status).toBe("COMPLETED");
    expect(stored.review?.status).toBe("PASSED");
    expect(provider.calls.map((call) => call.role)).toEqual(["issue-worker", "reviewer", "reviewer"]);
    expect(provider.calls[2]?.context).toContain("Agent review must start with");
    expect(provider.calls[2]?.context).toContain("Review: pass");
  });

  test("continues the existing pull request branch and keeps the review label until resolved", async () => {
    const issueNumber = issueBase + 7;
    const prHead = `agent/issue-${issueNumber}-existing`;
    const state = {
      labels: ["bug", config.ISSUE_REVIEW_REQUESTED_LABEL],
      comments: [] as Array<{ issue: number; body: string }>,
      createdIssues: [] as Array<{ title: string; body: string; labels: string[] }>,
      reviewWorktrees: [] as string[],
      async getIssue() {
        return { number: issueNumber, title: `Issue ${issueNumber}`, body: "Body", url: `https://github.com/acme/runner/issues/${issueNumber}`, labels: [...state.labels] };
      },
      async getPullRequest(_fullName: string, number: number) {
        return pullRequestShape(number, prHead, issueNumber);
      },
      async getPullRequestDiff() { return "diff --git a/src/app.ts b/src/app.ts"; },
      async getIssueContext() {
        return {
          issue: await state.getIssue(),
          issueComments: [],
          pullRequests: [{
            ...pullRequestShape(issueNumber, prHead, issueNumber),
            diff: "diff --git a/src/app.ts b/src/app.ts",
            reviews: [{ body: "Add a guard.", state: "CHANGES_REQUESTED", url: "https://github.com/acme/runner/pull/1#review-1", user: "reviewer", submittedAt: null }],
            comments: [],
          }],
        };
      },
      async createIssue(_fullName: string, title: string, body: string, createdLabels: string[]) {
        state.createdIssues.push({ title, body, labels: createdLabels });
        return { number: issueNumber + 1000, url: `https://github.com/acme/runner/issues/${issueNumber + 1000}` };
      },
      async setIssueLabels(_fullName: string, _number: number, labels: string[]) { state.labels = labels; },
      async addIssueComment(_fullName: string, issue: number, body: string) { state.comments.push({ issue, body }); },
    };
    const job = await claimed(issueNumber);
    const implementationResponse = [
      `Outcome: implemented`,
      `PR: https://github.com/acme/runner/pull/${issueNumber}`,
      "Addressed the requested review changes and pushed them to the existing branch.",
    ].join("\n");
    const provider = new FakeProvider([
      success(implementationResponse, "follow-up-implementation"),
      success("Review: pass\nThe requested changes are resolved.", "follow-up-review"),
    ]);
    const runner = createJobRunner({
      config,
      provider,
      github: state,
      createWorktree: async () => { throw new Error("fresh worktree must not be used for a review retry"); },
      createReviewWorktree: async (input) => { state.reviewWorktrees.push(input.branchName); return "agent/review-local"; },
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect(state.reviewWorktrees).toEqual([prHead]);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id }, include: { review: true } });
    expect(stored.status).toBe("COMPLETED");
    expect(stored.review?.status).toBe("PASSED");
    expect(provider.calls[0]?.context).toContain(`Mode: review follow-up`);
    expect(provider.calls[0]?.context).toContain(`Continue branch ${prHead}`);
    expect(state.labels).toContain(config.ISSUE_COMPLETED_LABEL);
    expect(state.labels).not.toContain(config.ISSUE_REVIEW_REQUESTED_LABEL);
    expect(state.comments.some((comment) => comment.issue === issueNumber && comment.body.includes(`Review: pass`)))
      .toBe(true);
  });

  test("re-applies the review-requested label on the existing branch when changes are still requested", async () => {
    const issueNumber = issueBase + 8;
    const prHead = `agent/issue-${issueNumber}-existing`;
    const state = {
      labels: ["bug", config.ISSUE_REVIEW_REQUESTED_LABEL],
      comments: [] as Array<{ issue: number; body: string }>,
      createdIssues: [] as Array<{ title: string; body: string; labels: string[] }>,
      reviewWorktrees: [] as string[],
      async getIssue() {
        return { number: issueNumber, title: `Issue ${issueNumber}`, body: "Body", url: `https://github.com/acme/runner/issues/${issueNumber}`, labels: [...state.labels] };
      },
      async getPullRequest(_fullName: string, number: number) {
        return pullRequestShape(number, prHead, issueNumber);
      },
      async getPullRequestDiff() { return "diff --git a/src/app.ts b/src/app.ts"; },
      async getIssueContext() {
        return {
          issue: await state.getIssue(),
          issueComments: [],
          pullRequests: [{
            ...pullRequestShape(issueNumber, prHead, issueNumber),
            diff: "diff --git a/src/app.ts b/src/app.ts",
            reviews: [{ body: "Not enough.", state: "CHANGES_REQUESTED", url: "https://github.com/acme/runner/pull/1#review-2", user: "reviewer", submittedAt: null }],
            comments: [],
          }],
        };
      },
      async createIssue(_fullName: string, title: string, body: string, createdLabels: string[]) {
        state.createdIssues.push({ title, body, labels: createdLabels });
        return { number: issueNumber + 1000, url: `https://github.com/acme/runner/issues/${issueNumber + 1000}` };
      },
      async setIssueLabels(_fullName: string, _number: number, labels: string[]) { state.labels = labels; },
      async addIssueComment(_fullName: string, issue: number, body: string) { state.comments.push({ issue, body }); },
    };
    const job = await claimed(issueNumber);
    const implementationResponse = [
      `Outcome: implemented`,
      `PR: https://github.com/acme/runner/pull/${issueNumber}`,
      "Pushed more changes to the existing branch.",
    ].join("\n");
    const provider = new FakeProvider([
      success(implementationResponse, "follow-up-implementation-2"),
      success("Review: changes_requested\nStill not enough.", "follow-up-review-2"),
    ]);
    const runner = createJobRunner({
      config,
      provider,
      github: state,
      createReviewWorktree: async (input) => { state.reviewWorktrees.push(input.branchName); return "agent/review-local"; },
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect(state.reviewWorktrees).toEqual([prHead]);
    expect(state.labels).toContain(config.ISSUE_REVIEW_REQUESTED_LABEL);
    expect(state.labels).not.toContain(config.ISSUE_COMPLETED_LABEL);
  });

  async function claimed(issueNumber: number) {
    const queued = await jobs.tryCreateQueued({
      repositoryId,
      environment,
      issueNumber,
      issueTitle: `Issue ${issueNumber}`,
      issueUrl: `https://github.com/acme/runner/issues/${issueNumber}`,
      issueBody: "Acceptance criteria",
      branchName: `agent/issue-${issueNumber}`,
      baselineCommit: "a".repeat(40),
      provider: "CODEX",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
    });
    expect(queued).not.toBeNull();
    return (await jobs.claim(queued!.id, environment, "runner-worker"))!;
  }
});

class FakeProvider implements AgentProvider {
  readonly name = "codex" as const;
  readonly calls: AgentRequest[] = [];
  readonly sessions: string[] = [];

  constructor(private readonly results: AgentResult[]) {}

  async execute(request: AgentRequest) {
    this.calls.push(request);
    const result = this.results.shift();
    if (!result) throw new Error("Missing fake provider result");
    if (result.sessionId) this.sessions.push(result.sessionId);
    if (request.responseFilePath) await Bun.write(request.responseFilePath, result.finalOutput);
    await request.onEvent?.({ type: "SESSION_STARTED", timestamp: new Date().toISOString() });
    return result;
  }
}

function success(finalOutput: string, sessionId: string): AgentResult {
  return { provider: "codex", sessionId, exitCode: 0, finalOutput, stderr: "" };
}

function pullRequestShape(number: number, head: string, issueNumber: number) {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/runner/pull/${number}`,
    base: "develop",
    head,
    body: `Closes #${issueNumber}`,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
  };
}

function fakeGitHub(issueNumber: number, branchName: string) {
  const state = {
    labels: ["bug", "agent:working"],
    comments: [] as Array<{ issue: number; body: string }>,
    createdIssues: [] as Array<{ title: string; body: string; labels: string[] }>,
    async getIssue() {
      return { number: issueNumber, title: "Issue", body: "Body", url: "https://github.com/acme/runner/issues/1", labels: [...state.labels] };
    },
    async getPullRequest(_fullName: string, number: number) {
      return pullRequestShape(number, branchName, issueNumber);
    },
    async getPullRequestDiff() { return "diff --git a/src/app.ts b/src/app.ts"; },
    async getIssueContext() {
      return {
        issue: await state.getIssue(),
        issueComments: [],
        pullRequests: [],
      };
    },
    async createIssue(_fullName: string, title: string, body: string, labels: string[]) {
      state.createdIssues.push({ title, body, labels });
      return { number: issueNumber + 1000, url: `https://github.com/acme/runner/issues/${issueNumber + 1000}` };
    },
    async setIssueLabels(_fullName: string, _number: number, labels: string[]) { state.labels = labels; },
    async addIssueComment(_fullName: string, issue: number, body: string) { state.comments.push({ issue, body }); },
  };
  return state;
}

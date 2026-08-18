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
      const findings = verdict === "pass" ? [] : [{
        file: "src/app.ts", line: 12, severity: "high", problem: "Missing guard", correction: "Add guard",
      }];
      const provider = new FakeProvider([
        success(JSON.stringify({
          outcome: "implemented",
          summary: "Implemented",
          tests: ["bun test"],
          commit: "abcdef1",
          pr: { number: job.issueNumber, url: `https://github.com/[REDACTED]/runner/pull/${job.issueNumber}`, base: "develop", head: job.branchName },
        }), `implementation-${offset}`),
        success(JSON.stringify({ verdict, summary: "Reviewed", findings }), `review-${offset}`),
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
      expect(stored.result).toMatchObject({ pr: { url: `https://github.com/acme/runner/pull/${job.issueNumber}` } });
      expect(stored.review?.status).toBe(verdict === "pass" ? "PASSED" : "CHANGES_REQUESTED");
      expect(provider.calls.map((call) => call.role)).toEqual(["issue-worker", "reviewer"]);
      expect(new Set(provider.calls.map((call) => call.signal)).size).toBe(1);
      expect(provider.calls[0]?.context).toContain("Live GitHub context fetched before execution");
      expect(github.labels).toContain(
        verdict === "pass" ? config.ISSUE_COMPLETED_LABEL : config.ISSUE_REVIEW_REQUESTED_LABEL,
      );
      expect(github.comments.some((comment) => comment.issue === job.issueNumber && comment.body.includes("Automated review")))
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
      success('{"outcome":"requires_decomposition","summary":"Broad","reason":"Two releases"}', "triage"),
      success(`{"outcome":"decomposed","summary":"Split","childIssues":[{"number":${job.issueNumber + 10},"url":"https://github.com/acme/runner/issues/${job.issueNumber + 10}","ready":true},{"number":${job.issueNumber + 11},"url":"https://github.com/acme/runner/issues/${job.issueNumber + 11}","ready":false}]}`, "decomposer"),
    ]);
    const github = fakeGitHub(job.issueNumber, job.branchName);
    const runner = createJobRunner({ config, provider, github, createWorktree: async (input) => input.worktreePath });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("DECOMPOSED");
    expect(provider.calls.map((call) => call.role)).toEqual(["issue-worker", "decomposer"]);
    expect(provider.sessions).toEqual(["triage", "decomposer"]);
    expect(provider.calls[1]?.context).toContain(`Queue-ready label for actionable children: ${config.ISSUE_READY_LABEL}`);
    expect(provider.calls[1]?.resultFilePath).toEndWith(`${job.id}-decomposer.json`);
    expect(github.labels).toContain(config.ISSUE_DECOMPOSED_LABEL);
  });

  test("records blocked and failed outcomes without leaving an active issue key", async () => {
    const blocked = await claimed(issueBase + 3);
    const blockedGitHub = fakeGitHub(blocked.issueNumber, blocked.branchName);
    const blockedRunner = createJobRunner({
      config,
      provider: new FakeProvider([success('{"outcome":"blocked","summary":"Need contract","question":"Which response code?"}', "blocked")]),
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

  test("fails with a clear message when the agent finishes without writing the outcome", async () => {
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
    expect(stored.errorMessage).toContain("without writing the structured outcome");
  });

  test("diagnoses failed Pull Request checks and opens a ready diagnostic issue", async () => {
    const job = await claimed(issueBase + 7);
    const provider = new FakeProvider([
      success(JSON.stringify({
        outcome: "implemented",
        summary: "Implemented",
        tests: ["bun test"],
        commit: "abcdef1",
        pr: { number: job.issueNumber + 1, url: `https://github.com/acme/runner/pull/${job.issueNumber + 1}`, base: "develop", head: job.branchName },
      }), "implementation-ci-failure"),
      success(JSON.stringify({
        verdict: "changes_requested",
        summary: "The failing check points to a missing guard.",
        findings: [{ file: "src/app.ts", line: 12, severity: "high", problem: "Missing guard", correction: "Add the guard." }],
      }), "pull-request-diagnosis"),
    ]);
    const github = fakeGitHub(job.issueNumber, job.branchName, [{
      name: "CI",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/acme/runner/actions/runs/1",
    }]);
    const runner = createJobRunner({
      config,
      provider,
      github,
      createWorktree: async (input) => input.worktreePath,
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("FAILED");
    expect(provider.calls.map((call) => call.role)).toEqual(["issue-worker", "pull-request"]);
    expect(github.labels).toContain(config.ISSUE_REVIEW_REQUESTED_LABEL);
    expect(github.comments.filter((comment) => comment.issue === job.issueNumber)).toHaveLength(1);
    expect(github.comments.filter((comment) => comment.issue === job.issueNumber + 1)).toHaveLength(1);
    expect(github.createdIssues).toHaveLength(1);
    expect(github.createdIssues[0]?.labels).toEqual([config.ISSUE_READY_LABEL]);
    expect(github.createdIssues[0]?.body).toContain("Stack trace:");
    expect(github.createdIssues[0]?.body).toContain("Missing guard");
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
    if (request.resultFilePath) await Bun.write(request.resultFilePath, result.finalOutput);
    await request.onEvent?.({ type: "SESSION_STARTED", timestamp: new Date().toISOString() });
    return result;
  }
}

function success(finalOutput: string, sessionId: string): AgentResult {
  return { provider: "codex", sessionId, exitCode: 0, finalOutput, stderr: "" };
}

function fakeGitHub(issueNumber: number, branchName: string, checks: Array<{
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}> = []) {
  const state = {
    labels: ["bug", "agent:working"],
    comments: [] as Array<{ issue: number; body: string }>,
    createdIssues: [] as Array<{ title: string; body: string; labels: string[] }>,
    async getIssue() {
      return { number: issueNumber, title: "Issue", body: "Body", url: "https://github.com/acme/runner/issues/1", labels: [...state.labels] };
    },
    async getPullRequest(_fullName: string, number: number) {
      return {
        number,
        title: `Pull request ${number}`,
        url: `https://github.com/acme/runner/pull/${number}`,
        base: "develop",
        head: branchName,
        body: `Closes #${issueNumber}`,
        additions: 12,
        deletions: 3,
        changedFiles: 2,
      };
    },
    async getPullRequestDiff() { return "diff --git a/src/app.ts b/src/app.ts"; },
    async getIssueContext() {
      return {
        issue: await state.getIssue(),
        issueComments: [],
        pullRequests: [],
      };
    },
    async getPullRequestChecks() { return checks; },
    async createIssue(_fullName: string, title: string, body: string, labels: string[]) {
      state.createdIssues.push({ title, body, labels });
      return { number: issueNumber + 1000, url: `https://github.com/acme/runner/issues/${issueNumber + 1000}` };
    },
    async setIssueLabels(_fullName: string, _number: number, labels: string[]) { state.labels = labels; },
    async addIssueComment(_fullName: string, issue: number, body: string) { state.comments.push({ issue, body }); },
  };
  return state;
}

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
      expect(github.labels).toContain(config.ISSUE_COMPLETED_LABEL);
      expect(github.comments.some((comment) => comment.issue === job.issueNumber && comment.body.includes("Automated review")))
        .toBe(true);
      expect(await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "PR_OPENED" } }))
        .toMatchObject({ metadata: { pullRequestUrl: `https://github.com/acme/runner/pull/${job.issueNumber}` } });
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
    expect(provider.calls[1]?.outputSchemaPath).toEndWith("decomposition-result.schema.json");
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
    const failedRunner = createJobRunner({
      config,
      provider: new FakeProvider([{ ...success("", "failed"), exitCode: 2, stderr: "provider failed" }]),
      github: fakeGitHub(failed.issueNumber, failed.branchName),
      createWorktree: async (input) => input.worktreePath,
    });
    expect(await failedRunner.run(failed.id, "runner-worker")).toBe(true);
    const failedStored = await prisma.job.findUniqueOrThrow({ where: { id: failed.id } });
    expect(failedStored.status).toBe("FAILED");
    expect(failedStored.activeIssueKey).toBeNull();
    expect(failedStored.errorMessage).toContain("provider failed");
    expect(failedStored.diagnostics).toMatchObject({
      stage: "implementation",
      role: "issue-worker",
      provider: "codex",
      model: "gpt-5.6-luna",
      sessionId: "failed",
      exitCode: 2,
      stderr: "provider failed",
    });
  });

  test("persists parser diagnostics with the final provider output and event timeline", async () => {
    const job = await claimed(issueBase + 6);
    const provider = new FakeProvider([{
      provider: "codex",
      sessionId: "parser-session",
      exitCode: 0,
      finalOutput: "The agent chat went somewhere and left trailing prose without a JSON document.",
      stderr: "",
    }]);
    const runner = createJobRunner({
      config,
      provider,
      github: fakeGitHub(job.issueNumber, job.branchName),
      createWorktree: async (input) => input.worktreePath,
    });
    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("FAILED");
    expect(stored.errorMessage).toBe("Agent result is not valid JSON");
    expect(stored.diagnostics).toMatchObject({
      stage: "parser",
      role: "issue-worker",
      provider: "codex",
      model: "gpt-5.6-luna",
      sessionId: "parser-session",
      exitCode: 0,
      finalOutput: "The agent chat went somewhere and left trailing prose without a JSON document.",
      causeChain: [expect.stringContaining("Agent result is not valid JSON")],
      events: [{ type: "SESSION_STARTED" }],
    });
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
    await request.onEvent?.({ type: "SESSION_STARTED", timestamp: new Date().toISOString() });
    return result;
  }
}

function success(finalOutput: string, sessionId: string): AgentResult {
  return { provider: "codex", sessionId, exitCode: 0, finalOutput, stderr: "" };
}

function fakeGitHub(issueNumber: number, branchName: string) {
  const state = {
    labels: ["bug", "agent:working"],
    comments: [] as Array<{ issue: number; body: string }>,
    async getIssue() {
      return { number: issueNumber, title: "Issue", body: "Body", url: "https://github.com/acme/runner/issues/1", labels: [...state.labels] };
    },
    async getPullRequest(_fullName: string, number: number) {
      return {
        number,
        url: `https://github.com/acme/runner/pull/${number}`,
        base: "develop",
        head: branchName,
        body: `Closes #${issueNumber}`,
      };
    },
    async getPullRequestDiff() { return "diff --git a/src/app.ts b/src/app.ts"; },
    async setIssueLabels(_fullName: string, _number: number, labels: string[]) { state.labels = labels; },
    async addIssueComment(_fullName: string, issue: number, body: string) { state.comments.push({ issue, body }); },
  };
  return state;
}

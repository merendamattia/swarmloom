import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseConfig } from "../src/core/config-schema.ts";
import type { AgentProvider, AgentRequest, AgentResult } from "../src/providers/index.ts";
import { ProviderProcessError } from "../src/providers/process.ts";

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
    await prisma.review.deleteMany({ where: { job: { repositoryId } } });
    await prisma.job.deleteMany({ where: { repositoryId } });
    await prisma.managedPullRequest.deleteMany({ where: { repositoryId } });
    await prisma.repository.delete({ where: { id: repositoryId } });
    await prisma.$disconnect();
  });

  test("implementation completes without running a reviewer and stores the managed pull request", async () => {
    const job = await claimed(issueBase, "IMPLEMENTATION", "ISSUE");
    const implementationResponse = [
      `Outcome: implemented`,
      `PR: https://github.com/acme/runner/pull/${job.issueNumber}`,
      "Frontend change: unchanged",
      `Implemented the requested change and ran the checks.`,
    ].join("\n");
    const provider = new FakeProvider([success(implementationResponse, `implementation-1`)]);
    const state = fakeGitHub(job.issueNumber, job.branchName, "b".repeat(40));
    const runner = createJobRunner({
      config,
      provider,
      github: state,
      createWorktree: async (input) => input.worktreePath,
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect(provider.calls.map((call) => call.role)).toEqual(["issue-worker"]);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("COMPLETED");
    expect(stored.pullRequestNumber).toBe(job.issueNumber);
    expect(stored.headSha).toBe("b".repeat(40));
    expect(stored.result).toBe(implementationResponse);
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { repositoryId_prNumber: { repositoryId, prNumber: job.issueNumber } } }))
      .toMatchObject({
        prNumber: job.issueNumber,
        issueNumber: job.issueNumber,
        headSha: "b".repeat(40),
        headBranch: job.branchName,
        baseBranch: "develop",
        workflow: "REVIEW_REQUESTED",
        implementationJobId: job.id,
      });
    expect(state.prLabels).toEqual([config.PR_REVIEW_REQUESTED_LABEL]);
    expect(state.labels).toEqual(["bug", config.ISSUE_WORKING_LABEL]);
    expect(state.prLabelWrites.every((labels) => labels.every((label) => label !== config.PR_REVIEW_PASSED_LABEL))).toBe(true);
    expect(state.comments.some((comment) => comment.issue === job.issueNumber && comment.body === implementationResponse))
      .toBe(true);
    expect(await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "PR_REVIEW_REQUESTED" } })).not.toBeNull();
    expect(await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "PR_OPENED" } })).not.toBeNull();
  });
  test("captures declared frontend evidence and posts exactly one visual comment", async () => {
    const job = await claimed(issueBase + 17, "IMPLEMENTATION", "ISSUE");
    const implementationResponse = [
      "Outcome: implemented",
      `PR: https://github.com/acme/runner/pull/${job.issueNumber}`,
      "Frontend change: changed",
      "Visual route: /dashboard",
      "Visual setup: none",
    ].join("\n");
    const state = fakeGitHub(job.issueNumber, job.branchName, "j".repeat(40));
    const visualCalls: Array<{ route: string; setup: string | null }> = [];
    const runner = createJobRunner({
      config,
      provider: new FakeProvider([success(implementationResponse, "implementation-visual")]),
      github: state,
      createWorktree: async (input) => input.worktreePath,
      visualVerification: {
        verify: async ({ route, setup }) => {
          visualCalls.push({ route, setup });
          return {
            status: "COMPLETED" as const,
            route,
            artifactUrl: "https://worker.example.com/api/artifacts/visual.png?token=signed",
            capturedAt: "2026-08-20T00:00:00.000Z",
            viewport: { width: 1440, height: 900 },
          };
        },
      },
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect(visualCalls).toEqual([{ route: "/dashboard", setup: "none" }]);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.visualVerification).toEqual({
      status: "COMPLETED",
      route: "/dashboard",
      artifactUrl: "https://worker.example.com/api/artifacts/visual.png?token=signed",
      capturedAt: "2026-08-20T00:00:00.000Z",
      viewport: { width: 1440, height: 900 },
    });
    expect(state.comments.filter(({ issue, body }) => issue === job.issueNumber && body.includes("## Visual evidence")))
      .toEqual([{
        issue: job.issueNumber,
        body: "## Visual evidence\n\nRoute: `/dashboard`\n\n![Screenshot of /dashboard](https://worker.example.com/api/artifacts/visual.png?token=signed)",
      }]);
    expect(await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "VISUAL_VERIFICATION_COMPLETED" } })).not.toBeNull();
  });

  test("persists incomplete visual verification without claiming a screenshot", async () => {
    const job = await claimed(issueBase + 18, "IMPLEMENTATION", "ISSUE");
    const response = [
      "Outcome: implemented",
      "PR: https://github.com/acme/runner/pull/" + job.issueNumber,
      "Frontend change: changed",
      "Visual route: /dashboard",
      "Visual setup: none",
    ].join("\n");
    const state = fakeGitHub(job.issueNumber, job.branchName, "k".repeat(40));
    const runner = createJobRunner({
      config,
      provider: new FakeProvider([success(response, "implementation-incomplete")]),
      github: state,
      createWorktree: async (input) => input.worktreePath,
      visualVerification: {
        verify: async ({ route }) => ({
          status: "INCOMPLETE" as const,
          route,
          reason: "Frontend did not become ready",
          capturedAt: "2026-08-20T00:00:00.000Z",
        }),
      },
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
      .toMatchObject({
        status: "COMPLETED",
        visualVerification: {
          status: "INCOMPLETE",
          route: "/dashboard",
          reason: "Frontend did not become ready",
        },
      });
    expect(state.comments.some(({ issue, body }) => issue === job.issueNumber && body.includes("## Visual evidence"))).toBe(false);
    expect(await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "VISUAL_VERIFICATION_INCOMPLETE" } })).not.toBeNull();
  });

  test("implementation with requires_decomposition queues a DECOMPOSITION job and never opens a PR", async () => {
    const job = await claimed(issueBase + 1, "IMPLEMENTATION", "ISSUE");
    const provider = new FakeProvider([success("Outcome: requires_decomposition\nToo broad to fit one PR.", "triage")]);
    const enqueued: string[] = [];
    const state = fakeGitHub(job.issueNumber, job.branchName, "c".repeat(40));
    const runner = createJobRunner({
      config,
      provider,
      github: state,
      queue: { enqueue: async (id) => { enqueued.push(id); } },
      createWorktree: async (input) => input.worktreePath,
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("COMPLETED");
    expect(enqueued).toHaveLength(1);
    const decomposition = await prisma.job.findUniqueOrThrow({ where: { id: enqueued[0] } });
    expect(decomposition).toMatchObject({
      jobType: "DECOMPOSITION",
      subjectType: "ISSUE",
      issueNumber: job.issueNumber,
      status: "QUEUED",
    });
    expect(state.labels).toEqual(["bug", config.ISSUE_WORKING_LABEL]);
  });

  test("decomposition runs a fresh decomposer session and records native child references", async () => {
    const job = await claimed(issueBase + 2, "DECOMPOSITION", "ISSUE");
    const provider = new FakeProvider([success("Outcome: decomposed\nSplit into two children.", "decomposer")]);
    const github = fakeGitHub(job.issueNumber, job.branchName, "d".repeat(40));
    const runner = createJobRunner({ config, provider, github, createWorktree: async (input) => input.worktreePath });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("DECOMPOSED");
    expect(provider.calls.map((call) => call.role)).toEqual(["decomposer"]);
    expect(provider.calls[0]?.context).toContain(`Queue-ready label for actionable children: ${config.ISSUE_READY_LABEL}`);
    expect(github.labels).toContain(config.ISSUE_DECOMPOSED_LABEL);
  });

  test("records blocked and failed outcomes without leaving an active issue key", async () => {
    const blocked = await claimed(issueBase + 3, "IMPLEMENTATION", "ISSUE");
    const blockedGitHub = fakeGitHub(blocked.issueNumber, blocked.branchName, "e".repeat(40));
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

    const failed = await claimed(issueBase + 4, "IMPLEMENTATION", "ISSUE");
    const failedGitHub = fakeGitHub(failed.issueNumber, failed.branchName, "f".repeat(40));
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
    expect(failedStored.diagnostics).toMatchObject({
      stage: "implementation",
      role: "issue-worker",
      provider: "codex",
      model: "gpt-5.6-luna",
      sessionId: "failed",
      exitCode: 2,
      stderr: "provider failed",
    });
    expect(failedGitHub.labels).not.toContain(config.ISSUE_WORKING_LABEL);
    expect(failedGitHub.createdIssues).toEqual([]);

    const diagnostic = await claimed(issueBase + 40, "IMPLEMENTATION", "ISSUE");
    const diagnosticGitHub = fakeGitHub(diagnostic.issueNumber, diagnostic.branchName, "9".repeat(40));
    const diagnosticRunner = createJobRunner({
      config: { ...config, CREATE_DIAGNOSTIC_ISSUES: true },
      provider: new FakeProvider([{ ...success("", "failed-with-diagnostic"), exitCode: 2, stderr: "provider failed" }]),
      github: diagnosticGitHub,
      createWorktree: async (input) => input.worktreePath,
    });
    expect(await diagnosticRunner.run(diagnostic.id, "runner-worker")).toBe(true);
    expect(diagnosticGitHub.createdIssues[0]?.labels).toEqual([config.ISSUE_READY_LABEL]);
    expect(diagnosticGitHub.createdIssues[0]?.body).toContain("Stack trace:");
  });

  test("aborts an active provider when cancellation makes its heartbeat fail", async () => {
    const job = await claimed(issueBase + 5, "IMPLEMENTATION", "ISSUE");


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
      github: fakeGitHub(job.issueNumber, job.branchName, "g".repeat(40)),
      createWorktree: async (input) => input.worktreePath,
      heartbeatIntervalMs: 10,
    });
    const running = runner.run(job.id, "runner-worker");
    await didStart;
    expect(await jobs.cancel(job.id)).toBe(true);
    expect(await running).toBe(false);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("CANCELLED");
  });


  test("persists parser diagnostics with final output and the event timeline", async () => {
    const job = await claimed(issueBase + 11, "IMPLEMENTATION", "ISSUE");
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "diagnostics-secret-token";
    try {
      const provider = new FakeProvider([
        success("Implemented the change and ran the checks.", "parser-first"),
        success("Still no outcome marker: diagnostics-secret-token present.", "parser-second"),
      ]);
      const runner = createJobRunner({
        config,
        provider,
        github: fakeGitHub(job.issueNumber, job.branchName, "8".repeat(40)),
        createWorktree: async (input) => input.worktreePath,
      });

      expect(await runner.run(job.id, "runner-worker")).toBe(true);
      const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(stored.status).toBe("FAILED");
      expect(stored.errorMessage).toContain("Agent response must start with");
      expect(stored.diagnostics).toMatchObject({
        stage: "parser",
        role: "issue-worker",
        provider: "codex",
        model: "gpt-5.6-luna",
        sessionId: "parser-second",
        exitCode: 0,
        finalOutput: "Still no outcome marker: [REDACTED] present.",
        causeChain: [
          expect.stringContaining("Agent response must start with"),
          "Still no outcome marker: [REDACTED] present.",
        ],
        events: [{ type: "SESSION_STARTED" }],
      });
    } finally {
      process.env.GITHUB_TOKEN = previousToken;
    }
  });

  test("preserves the session ID when invalid JSONL follows SESSION_STARTED", async () => {
    const job = await claimed(issueBase + 12, "IMPLEMENTATION", "ISSUE");
    const provider: AgentProvider = {
      name: "codex",
      execute: async (request) => {
        await request.onEvent?.({
          type: "SESSION_STARTED",
          timestamp: "2026-08-20T00:00:00.000Z",
          metadata: { sessionId: "invalid-jsonl-session" },
        });
        throw new ProviderProcessError("Provider emitted invalid JSONL", 3, "stderr evidence");
      },
    };
    const runner = createJobRunner({
      config,
      provider,
      github: fakeGitHub(job.issueNumber, job.branchName, "7".repeat(40)),
      createWorktree: async (input) => input.worktreePath,
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("FAILED");
    expect(stored.diagnostics).toMatchObject({
      stage: "provider_process",
      role: "issue-worker",
      sessionId: "invalid-jsonl-session",
      exitCode: 3,
      stderr: "stderr evidence",
      events: [{ type: "SESSION_STARTED", timestamp: "2026-08-20T00:00:00.000Z" }],
    });
  });
  test("retries the role when the agent finishes without writing the response, then fails clearly if it never writes it", async () => {


    const job = await claimed(issueBase + 6, "IMPLEMENTATION", "ISSUE");
    let calls = 0;
    const provider: AgentProvider = {
      name: "opencode",
      execute: async () => {
        calls++;
        return { provider: "opencode", sessionId: `session-missing-${calls}`, exitCode: 0, finalOutput: "", stderr: "" };
      },
    };
    const runner = createJobRunner({
      config,
      provider,
      github: fakeGitHub(job.issueNumber, job.branchName, "h".repeat(40)),
      createWorktree: async (input) => input.worktreePath,
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect(calls).toBe(2);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("FAILED");
    expect(stored.errorMessage).toContain("without writing the response");
  });

  test("fix updates the existing PR branch, restores review-requested, and rejects a push that never lands", async () => {
    const prHead = `agent/issue-${issueBase + 7}-existing`;
    const managed = await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber: 900,
        issueNumber: issueBase + 7,
        issueTitle: `Issue ${issueBase + 7}`,
        issueUrl: `https://github.com/acme/runner/issues/${issueBase + 7}`,
        headBranch: prHead,
        headSha: "1".repeat(40),
        baseBranch: "develop",
        state: "OPEN",
        workflow: "FIX_REQUESTED",
        fixReason: "REVIEW_CHANGES_REQUESTED",
        fixDetails: "The reviewer reproduced CI locally: bun test failed",
      },
    });
    const state = fixGitHub(config, issueBase + 7, prHead, managed.prNumber);
    const reviewWorktrees: string[] = [];

    const fixedResponse = "Outcome: implemented\nFixed the failing test and pushed to the same branch.";
    const provider = new FakeProvider([success(fixedResponse, "fix-session")]);
    const runner = createJobRunner({
      config,
      provider,
      github: state,
      createReviewWorktree: async (input) => { reviewWorktrees.push(input.branchName); return "agent/fix-local"; },
    });
    const job = await claimed(issueBase + 7, "FIX", "PULL_REQUEST", {
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl: "https://github.com/acme/runner/pull/900",
      headSha: "1".repeat(40),
      trigger: "REVIEW_CHANGES_REQUESTED",
    });
    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect(reviewWorktrees).toEqual([prHead]);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("COMPLETED");
    expect(stored.headSha).toBe("2".repeat(40));
    expect(stored.activePrKey).toBeNull();
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { id: managed.id } }))
      .toMatchObject({ headSha: "2".repeat(40), workflow: "REVIEW_REQUESTED", fixReason: null, fixCycleCount: 1 });
    expect(state.prLabels).toEqual([config.PR_REVIEW_REQUESTED_LABEL]);
    expect(state.comments.some((comment) => comment.issue === managed.prNumber && comment.body === fixedResponse)).toBe(true);
    expect(provider.calls[0]?.context).toContain("Fix reason: REVIEW_CHANGES_REQUESTED");
    expect(provider.calls[0]?.context).toContain("bun test failed");

    const unchanged = await claimed(issueBase + 7, "FIX", "PULL_REQUEST", {
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl: "https://github.com/acme/runner/pull/900",
      headSha: "2".repeat(40),
      trigger: "REVIEW_CHANGES_REQUESTED",
    });
    const unchangedRunner = createJobRunner({
      config,
      provider: new FakeProvider([success("Outcome: implemented\nNothing changed.", "fix-noop")]),
      github: fixGitHub(config, issueBase + 7, prHead, managed.prNumber, "2".repeat(40)),
      createReviewWorktree: async () => "agent/fix-local",
    });
    expect(await unchangedRunner.run(unchanged.id, "runner-worker")).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: unchanged.id } })).status).toBe("FAILED");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: unchanged.id } })).errorMessage).toContain("push was not detected");
  });

  test("a blocked FIX stops without requiring a new pull request head", async () => {
    const issueNumber = issueBase + 15;
    const managed = await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber: 908,
        issueNumber,
        issueTitle: `Issue ${issueNumber}`,
        issueUrl: `https://github.com/acme/runner/issues/${issueNumber}`,
        headBranch: `agent/issue-${issueNumber}-existing`,
        headSha: "b".repeat(40),
        baseBranch: "develop",
        state: "OPEN",
        workflow: "FIX_REQUESTED",
        fixReason: "REVIEW_CHANGES_REQUESTED",
      },
    });
    const state = fixGitHub(config, issueNumber, managed.headBranch, managed.prNumber, managed.headSha);
    const job = await claimed(issueNumber, "FIX", "PULL_REQUEST", {
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl: "https://github.com/acme/runner/pull/908",
      headSha: managed.headSha,
      trigger: "REVIEW_CHANGES_REQUESTED",
    });
    const response = "Outcome: blocked\nThe requested change needs a product decision.";
    const runner = createJobRunner({
      config,
      provider: new FakeProvider([success(response, "fix-blocked")]),
      github: state,
      createReviewWorktree: async () => "agent/fix-local",
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
      .toMatchObject({ status: "BLOCKED", result: response });
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { id: managed.id } }))
      .toMatchObject({ blocked: true });
    expect(state.prLabels).toEqual([config.ISSUE_HUMAN_REVIEW_LABEL]);
    expect(state.labels).toEqual(["bug", config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL]);
    expect(state.comments.some((comment) => comment.issue === managed.prNumber && comment.body === response)).toBe(true);
  });

  test("the loop guard blocks the workflow once the fix cycle limit is reached", async () => {
    const issueNumber = issueBase + 8;
    const managed = await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber: 901,
        issueNumber,
        issueTitle: `Issue ${issueNumber}`,
        issueUrl: `https://github.com/acme/runner/issues/${issueNumber}`,
        headBranch: `agent/issue-${issueNumber}-existing`,
        headSha: "3".repeat(40),
        baseBranch: "develop",
        state: "OPEN",
        workflow: "FIX_REQUESTED",
        fixReason: "REVIEW_CHANGES_REQUESTED",
        fixCycleCount: config.MAX_AUTOMATIC_FIX_CYCLES - 1,
      },
    });
    const state = fixGitHub(config, issueNumber, `agent/issue-${issueNumber}-existing`, managed.prNumber);
    const job = await claimed(issueNumber, "FIX", "PULL_REQUEST", {
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl: "https://github.com/acme/runner/pull/901",
      headSha: "3".repeat(40),
      trigger: "REVIEW_CHANGES_REQUESTED",
    });
    const runner = createJobRunner({
      config,
      provider: new FakeProvider([success("Outcome: implemented\nFixed again.", "fix-loop")]),
      github: state,
      createReviewWorktree: async () => "agent/fix-local",
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("COMPLETED");
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { id: managed.id } }))
      .toMatchObject({ blocked: true, fixCycleCount: config.MAX_AUTOMATIC_FIX_CYCLES });
    expect(state.prLabels).toEqual([config.ISSUE_HUMAN_REVIEW_LABEL]);
    expect(state.labels).toContain(config.ISSUE_BLOCKED_LABEL);
    expect(state.labels).toContain(config.ISSUE_HUMAN_REVIEW_LABEL);
    expect(await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "LOOP_GUARD_TRIPPED" } })).not.toBeNull();
  });

  test("review pass applies PR review-passed and issue ready-to-merge without touching the implementation job", async () => {
    const issueNumber = issueBase + 9;
    const implementation = await claimed(issueNumber, "IMPLEMENTATION", "ISSUE");
    await prisma.job.update({ where: { id: implementation.id }, data: { status: "COMPLETED", activeIssueKey: null } });
    const managed = await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber: 902,
        issueNumber,
        issueTitle: `Issue ${issueNumber}`,
        issueUrl: `https://github.com/acme/runner/issues/${issueNumber}`,
        headBranch: `agent/issue-${issueNumber}`,
        headSha: "4".repeat(40),
        baseBranch: "develop",
        state: "OPEN",
        workflow: "REVIEW_REQUESTED",
        fixCycleCount: 3,
      },
    });
    const state = reviewGitHub(config, issueNumber, `agent/issue-${issueNumber}`, managed.prNumber, "4".repeat(40));
    const job = await claimed(issueNumber, "REVIEW", "PULL_REQUEST", {
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl: "https://github.com/acme/runner/pull/902",
      headSha: "4".repeat(40),
    });
    const provider = new FakeProvider([success("Review: pass\nLooks good.", "review-pass")]);
    const runner = createJobRunner({
      config,
      provider,
      github: state,
      createReviewWorktree: async () => "agent/review-local",
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id }, include: { review: true } });
    expect(stored.status).toBe("COMPLETED");
    expect(stored.review?.status).toBe("PASSED");
    expect(stored.review?.headSha).toBe("4".repeat(40));
    expect(provider.calls[0]?.context).toContain("Reproduce the repository CI locally before deciding the verdict");
    expect(state.prLabels).toEqual([config.PR_REVIEW_PASSED_LABEL]);
    expect(state.labels).toEqual(["bug", config.ISSUE_READY_TO_MERGE_LABEL]);
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { id: managed.id } }))
      .toMatchObject({ workflow: "REVIEW_PASSED", fixCycleCount: 0 });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: implementation.id } })).status).toBe("COMPLETED");
    expect(await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "READY_TO_MERGE" } })).not.toBeNull();
  });

  test("review changes-requested moves the PR to fix-requested with the reviewer feedback", async () => {
    const issueNumber = issueBase + 10;
    const managed = await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber: 903,
        issueNumber,
        issueTitle: `Issue ${issueNumber}`,
        issueUrl: `https://github.com/acme/runner/issues/${issueNumber}`,
        headBranch: `agent/issue-${issueNumber}`,
        headSha: "5".repeat(40),
        baseBranch: "develop",
        state: "OPEN",
        workflow: "REVIEW_REQUESTED",
      },
    });
    const state = reviewGitHub(config, issueNumber, `agent/issue-${issueNumber}`, managed.prNumber, "5".repeat(40));
    const job = await claimed(issueNumber, "REVIEW", "PULL_REQUEST", {
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl: "https://github.com/acme/runner/pull/903",
      headSha: "5".repeat(40),
    });
    const feedback = "Review: changes_requested\nAdd a guard.";
    const runner = createJobRunner({
      config,
      provider: new FakeProvider([success(feedback, "review-changes")]),
      github: state,
      createReviewWorktree: async () => "agent/review-local",
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id }, include: { review: true } });
    expect(stored.status).toBe("COMPLETED");
    expect(stored.review?.status).toBe("CHANGES_REQUESTED");
    expect(state.prLabels).toEqual([config.PR_FIX_REQUESTED_LABEL]);
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { id: managed.id } }))
      .toMatchObject({ workflow: "FIX_REQUESTED", fixReason: "REVIEW_CHANGES_REQUESTED", fixDetails: feedback });
    expect(await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "PR_FIX_REQUESTED" } })).not.toBeNull();
  });

  test("a review pass cannot finalize the issue when the PR label transition fails", async () => {
    const issueNumber = issueBase + 16;
    const managed = await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber: 909,
        issueNumber,
        issueTitle: `Issue ${issueNumber}`,
        issueUrl: `https://github.com/acme/runner/issues/${issueNumber}`,
        headBranch: `agent/issue-${issueNumber}`,
        headSha: "c".repeat(40),
        baseBranch: "develop",
        state: "OPEN",
        workflow: "REVIEW_REQUESTED",
      },
    });
    const state = reviewGitHub(config, issueNumber, managed.headBranch, managed.prNumber, managed.headSha);
    state.setPullRequestLabels = async () => { throw new Error("GitHub label write failed"); };
    const job = await claimed(issueNumber, "REVIEW", "PULL_REQUEST", {
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl: "https://github.com/acme/runner/pull/909",
      headSha: managed.headSha,
    });
    const runner = createJobRunner({
      config,
      provider: new FakeProvider([success("Review: pass\nReady.", "review-label-failure")]),
      github: state,
      createReviewWorktree: async () => "agent/review-local",
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
      .toMatchObject({ status: "FAILED", errorMessage: "GitHub label write failed" });
    expect(state.labels).toEqual(["bug", config.ISSUE_BLOCKED_LABEL]);
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { id: managed.id } }))
      .toMatchObject({ workflow: "REVIEW_REQUESTED" });
  });

  test("a review on an old head SHA is discarded and never finalizes a newer PR head", async () => {
    const issueNumber = issueBase + 11;
    const managed = await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber: 904,
        issueNumber,
        issueTitle: `Issue ${issueNumber}`,
        issueUrl: `https://github.com/acme/runner/issues/${issueNumber}`,
        headBranch: `agent/issue-${issueNumber}`,
        headSha: "6".repeat(40),
        baseBranch: "develop",
        state: "OPEN",
        workflow: "REVIEW_REQUESTED",
      },
    });
    // the PR head moves while the review job for the old SHA runs
    const state = reviewGitHub(config, issueNumber, `agent/issue-${issueNumber}`, managed.prNumber, "6".repeat(40), "7".repeat(40));
    const job = await claimed(issueNumber, "REVIEW", "PULL_REQUEST", {
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl: "https://github.com/acme/runner/pull/904",
      headSha: "6".repeat(40),
    });
    const runner = createJobRunner({
      config,
      provider: new FakeProvider([success("Review: pass\nLooks good.", "review-stale")]),
      github: state,
      createReviewWorktree: async () => "agent/review-local",
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("COMPLETED");
    expect(await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "STALE_RESULT_DISCARDED" } })).not.toBeNull();
    expect(state.prLabels).toEqual([config.PR_REVIEW_REQUESTED_LABEL]);
    expect(state.labels).toEqual(["bug", "agent:working"]);
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { id: managed.id } }))
      .toMatchObject({ workflow: "REVIEW_REQUESTED" });
    expect(state.comments.some((comment) => comment.issue === managed.prNumber)).toBe(false);
  });

  test("a stale review on a newer head discards the result before any agent session runs", async () => {
    const issueNumber = issueBase + 12;
    const managed = await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber: 905,
        issueNumber,
        issueTitle: `Issue ${issueNumber}`,
        issueUrl: `https://github.com/acme/runner/issues/${issueNumber}`,
        headBranch: `agent/issue-${issueNumber}`,
        headSha: "6".repeat(40),
        baseBranch: "develop",
        state: "OPEN",
        workflow: "REVIEW_REQUESTED",
      },
    });
    const state = reviewGitHub(config, issueNumber, `agent/issue-${issueNumber}`, managed.prNumber, "7".repeat(40));
    const job = await claimed(issueNumber, "REVIEW", "PULL_REQUEST", {
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl: "https://github.com/acme/runner/pull/905",
      headSha: "6".repeat(40),
    });
    const provider = new FakeProvider([]);
    const runner = createJobRunner({
      config,
      provider,
      github: state,
      createReviewWorktree: async () => "agent/review-local",
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect(provider.calls).toEqual([]);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("COMPLETED");
    expect(await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "STALE_RESULT_DISCARDED" } })).not.toBeNull();
  });

  test("retrying a failed review only re-creates review work and never reruns the implementation", async () => {
    const issueNumber = issueBase + 13;
    const implementation = await claimed(issueNumber, "IMPLEMENTATION", "ISSUE");
    await prisma.job.update({ where: { id: implementation.id }, data: { status: "COMPLETED", activeIssueKey: null } });
    const managed = await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber: 906,
        issueNumber,
        issueTitle: `Issue ${issueNumber}`,
        issueUrl: `https://github.com/acme/runner/issues/${issueNumber}`,
        headBranch: `agent/issue-${issueNumber}`,
        headSha: "8".repeat(40),
        baseBranch: "develop",
        state: "OPEN",
        workflow: "REVIEW_REQUESTED",
      },
    });
    const state = reviewGitHub(config, issueNumber, `agent/issue-${issueNumber}`, managed.prNumber, "8".repeat(40));
    const failed = await claimed(issueNumber, "REVIEW", "PULL_REQUEST", {
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl: "https://github.com/acme/runner/pull/906",
      headSha: "8".repeat(40),
    });
    const failedRunner = createJobRunner({
      config,
      provider: new FakeProvider([{ ...success("", "review-fail"), exitCode: 1, stderr: "reviewer crashed" }]),
      github: state,
      createReviewWorktree: async () => "agent/review-local",
    });
    expect(await failedRunner.run(failed.id, "runner-worker")).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("FAILED");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: implementation.id } })).status).toBe("COMPLETED");

    const retried = await claimed(issueNumber, "REVIEW", "PULL_REQUEST", {
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl: "https://github.com/acme/runner/pull/906",
      headSha: "8".repeat(40),
    });
    const retriedRunner = createJobRunner({
      config,
      provider: new FakeProvider([success("Review: pass\nReady now.", "review-retry")]),
      github: state,
      createReviewWorktree: async () => "agent/review-local",
    });
    expect(await retriedRunner.run(retried.id, "runner-worker")).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: retried.id } })).status).toBe("COMPLETED");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: implementation.id } })).status).toBe("COMPLETED");
  });

  test("failing fixes also consume the cycle budget and eventually block the workflow", async () => {
    const issueNumber = issueBase + 14;
    const managed = await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber: 907,
        issueNumber,
        issueTitle: `Issue ${issueNumber}`,
        issueUrl: `https://github.com/acme/runner/issues/${issueNumber}`,
        headBranch: `agent/issue-${issueNumber}-existing`,
        headSha: "9".repeat(40),
        baseBranch: "develop",
        state: "OPEN",
        workflow: "FIX_REQUESTED",
        fixReason: "REVIEW_CHANGES_REQUESTED",
        fixCycleCount: config.MAX_AUTOMATIC_FIX_CYCLES - 1,
      },
    });
    const state = fixGitHub(config, issueNumber, `agent/issue-${issueNumber}-existing`, managed.prNumber);
    const job = await claimed(issueNumber, "FIX", "PULL_REQUEST", {
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl: "https://github.com/acme/runner/pull/907",
      headSha: "9".repeat(40),
      trigger: "REVIEW_CHANGES_REQUESTED",
    });
    const runner = createJobRunner({
      config,
      provider: new FakeProvider([{ ...success("", "fix-crash"), exitCode: 2, stderr: "fixer crashed" }]),
      github: state,
      createReviewWorktree: async () => "agent/fix-local",
    });

    expect(await runner.run(job.id, "runner-worker")).toBe(true);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("FAILED");
    expect(await prisma.managedPullRequest.findUniqueOrThrow({ where: { id: managed.id } }))
      .toMatchObject({ blocked: true, fixCycleCount: config.MAX_AUTOMATIC_FIX_CYCLES });
    expect(state.prLabels).toEqual([config.ISSUE_HUMAN_REVIEW_LABEL]);
    expect(await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "LOOP_GUARD_TRIPPED" } })).not.toBeNull();
  });

  function providerCallsOf(_runner: ReturnType<typeof createJobRunner>) {
    return [] as AgentRequest[];
  }

  async function claimed(
    issueNumber: number,
    jobType: "IMPLEMENTATION" | "FIX" | "REVIEW" | "DECOMPOSITION",
    subjectType: "ISSUE" | "PULL_REQUEST",
    extra: Partial<Parameters<typeof jobs.tryCreateQueued>[0]> = {},
  ) {
    const queued = await jobs.tryCreateQueued({
      repositoryId,
      environment,
      jobType,
      subjectType,
      issueNumber,
      issueTitle: `Issue ${issueNumber}`,
      issueUrl: `https://github.com/acme/runner/issues/${issueNumber}`,
      issueBody: "Acceptance criteria",
      branchName: `agent/issue-${issueNumber}`,
      baselineCommit: "a".repeat(40),
      provider: "CODEX",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      ...extra,
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

function pullRequestShape(number: number, head: string, issueNumber: number, headSha: string) {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/runner/pull/${number}`,
    base: "develop",
    head,
    headSha,
    state: "open",
    merged: false,
    body: `Closes #${issueNumber}`,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
  };
}

function fakeGitHub(issueNumber: number, branchName: string, headSha: string) {
  const state = {
    labels: ["bug", "agent:working"],
    prLabels: [] as string[],
    prLabelWrites: [] as string[][],
    comments: [] as Array<{ issue: number; body: string }>,
    createdIssues: [] as Array<{ title: string; body: string; labels: string[] }>,
    async getIssue() {
      return { number: issueNumber, title: "Issue", body: "Body", url: "https://github.com/acme/runner/issues/1", labels: [...state.labels] };
    },
    async getPullRequest(_fullName: string, number: number) {
      return pullRequestShape(number, branchName, issueNumber, headSha);
    },
    async getPullRequestDiff() { return "diff --git a/src/app.ts b/src/app.ts"; },
    async getPullRequestLabels() { return [...state.prLabels]; },
    async setPullRequestLabels(_fullName: string, _number: number, labels: string[]) {
      state.prLabelWrites.push([...labels]);
      state.prLabels.splice(0, state.prLabels.length, ...labels);
    },
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
    async setIssueLabels(_fullName: string, _number: number, labels: string[]) { state.labels.splice(0, state.labels.length, ...labels); },
    async addIssueComment(_fullName: string, issue: number, body: string) { state.comments.push({ issue, body }); },
  };
  return state;
}

function fixGitHub(config: ReturnType<typeof parseConfig>, issueNumber: number, prHead: string, prNumber: number, nextSha = "2".repeat(40)) {
  const state = fakeGitHub(issueNumber, prHead, nextSha);
  state.prLabels = [config.PR_FIX_REQUESTED_LABEL];
  return {
    ...state,
    async getPullRequest(_fullName: string, number: number) {
      return pullRequestShape(number, prHead, issueNumber, nextSha);
    },
    async getIssueContext() {
      return {
        issue: await state.getIssue(),
        issueComments: [],
        pullRequests: [{ ...pullRequestShape(prNumber, prHead, issueNumber, nextSha), diff: "diff --git a/x.ts b/x.ts", reviews: [], comments: [] }],
      };
    },
  };
}

function reviewGitHub(config: ReturnType<typeof parseConfig>, issueNumber: number, prHead: string, prNumber: number, headSha: string, movedSha?: string) {
  const state = fakeGitHub(issueNumber, prHead, movedSha ?? headSha);
  state.prLabels = [config.PR_REVIEW_REQUESTED_LABEL];
  return {
    ...state,
    async getPullRequest(_fullName: string, number: number) {
      return pullRequestShape(number, prHead, issueNumber, movedSha ?? headSha);
    },
    async getIssueContext() {
      return {
        issue: await state.getIssue(),
        issueComments: [],
        pullRequests: [{
          ...pullRequestShape(prNumber, prHead, issueNumber, movedSha ?? headSha),
          diff: "diff --git a/src/app.ts b/src/app.ts",
          reviews: [],
          comments: [],
        }],
      };
    },
  };
}

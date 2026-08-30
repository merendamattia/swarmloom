import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config-schema.ts";
import { readApplicationVersion } from "../src/core/version.ts";

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("operations API", () => {
  let prisma: typeof import("../src/core/db.ts").prisma;
  let app: ReturnType<typeof import("../src/api/app.ts").createApp>;
  let repositoryId = "";
  let jobId = "";
  let scanCalls = 0;
  const enqueuedJobs: string[] = [];
  let restartCalls = 0;
  let version = "";
  const unique = crypto.randomUUID();
  const apiJobId = crypto.randomUUID();
  const labels = ["bug", "agent:working"];
  const createdIssues: Array<{ title: string; body: string; labels: string[] }> = [];
  let createIssueError: Error | undefined;
  let throwAfterIssueCreation = false;
  let beforeCreateIssue: (() => Promise<void>) | undefined;
  let afterCreateIssue: (() => Promise<void>) | undefined;
  let reconciledIssue: { number: number; url: string } | undefined;
  let findIssueCalls = 0;
  const removedWorktrees: string[] = [];
  let pullRequestHead = "a".repeat(40);
  const pullRequestLabels = ["agent:review-requested"];
  const config = parseConfig({
    APP_ENV: "test",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused:unused@localhost:5432/unused",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:18422",
    SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY ?? "test-settings-encryption-key-0123456789",
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORIES: "acme/api-test",
    AGENT_PROVIDER: "codex",
  });

  beforeAll(async () => {
    ({ prisma } = await import("../src/core/db.ts"));
    const { createApp } = await import("../src/api/app.ts");
    const { createEventService } = await import("../src/events/service.ts");
    const { createSettingsService } = await import("../src/core/settings-service.ts");
    version = await readApplicationVersion();
    const repository = await prisma.repository.create({
      data: {
        fullName: `acme/api-${unique}`,
        cloneUrl: `https://github.com/acme/api-${unique}.git`,
        status: "READY",
        developAvailable: true,
      },
    });
    repositoryId = repository.id;
    const job = await prisma.job.create({
      data: {
        id: apiJobId,
        repositoryId,
        environment: "test",
        issueNumber: 99,
        issueTitle: `Searchable ${unique}`,
        issueUrl: `https://github.com/acme/api-${unique}/issues/99`,
        issueBody: "Acceptance criteria",
        status: "QUEUED",
        activeIssueKey: `${repositoryId}:99`,
        branchName: "agent/issue-99",
        baselineCommit: "a".repeat(40),
        provider: "CODEX",
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
      },
    });
    jobId = job.id;
    app = createApp({
      config,
      startup: {
        database: "ok",
        dataDirectory: "/data",
        runtimeDirectory: "/app/agent-runtime",
        gitVersion: "git version 2.43.0",
        ghVersion: "gh version 2.45.0",
        provider: "codex",
        providerVersion: "test",
        version,
      },
      events: createEventService(),
      scanner: {
        run: async () => ({ id: `scan-${++scanCalls}`, status: "COMPLETED" }),
      },
      github: {
        getIssue: async () => ({
          number: 99,
          title: "Issue",
          body: "Body",
          url: "https://github.com/acme/api/issues/99",
          labels: [...labels],
        }),
        setIssueLabels: async (_repository, _issue, next) => {
          labels.splice(0, labels.length, ...next);
        },
        createIssue: async (_repository, title, body, issueLabels) => {
          if (createIssueError) throw createIssueError;
          await beforeCreateIssue?.();
          const issue = { number: 123, url: "https://github.com/acme/api-test/issues/123" };
          createdIssues.push({ title, body, labels: issueLabels });
          if (throwAfterIssueCreation) throw new Error("GitHub response was lost");
          await afterCreateIssue?.();
          return issue;
        },
        findIssueByMarker: async () => {
          findIssueCalls += 1;
          return reconciledIssue;
        },
        addIssueComment: async () => {},
        getPullRequest: async (_repository, number) => ({
          number,
          title: "Pull request",
          url: "https://github.com/acme/api-test/pull/456",
          base: "develop",
          head: "agent/issue-456",
          headSha: pullRequestHead,
          state: "open",
          merged: false,
          body: "Closes #456",
          additions: 1,
          deletions: 1,
          changedFiles: 1,
        }),
        getPullRequestLabels: async () => [...pullRequestLabels],
        setPullRequestLabels: async (_repository, _number, next) => {
          pullRequestLabels.splice(0, pullRequestLabels.length, ...next);
        },
      },
      queue: {
        health: async () => "PONG",
        remove: async () => true,
        enqueue: async (id) => { enqueuedJobs.push(id); },
      },
      removeWorktree: async ({ worktreePath }) => { removedWorktrees.push(worktreePath); },
      settings: createSettingsService(config),
      scheduler: { restart: () => { restartCalls += 1; } },
    });
  });

  afterAll(async () => {
    await prisma.jobEvent.deleteMany({ where: { repositoryId } });
    await prisma.job.deleteMany({ where: { repositoryId } });
    await prisma.managedPullRequest.deleteMany({ where: { repositoryId } });
    await prisma.runtimeSetting.deleteMany({ where: { environment: "test" } });
    await prisma.repository.delete({ where: { id: repositoryId } });
    await prisma.$disconnect();
  });

  test("reports safe readiness and searches job history", async () => {
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: "ok",
      provider: "codex",
      services: {
        api: { state: "unavailable" },
        worker: { state: "unavailable" },
        database: { state: "healthy", detail: "ok" },
        queue: { state: "healthy", detail: "ok" },
        scheduler: { state: "unavailable" },
      },
    });

    const status = await app.request("/api/status");
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({
      version,
      providerUsage: {
        status: "unavailable",
        availability: "unknown",
        spendControlReached: null,
        rateLimitReachedType: null,
        observedAt: null,
        windows: [],
      },
    });
    expect(JSON.stringify(statusBody)).not.toContain("test-token");

    await prisma.job.update({ where: { id: jobId }, data: {
      status: "RUNNING",
      startedAt: new Date(),
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 120,
      reasoningOutputTokens: 80,
      totalTokens: 2_147_483_648,
    } });
    expect(await (await app.request("/api/dashboard")).json())
      .toMatchObject({ activeJobs: [{
        id: jobId,
        reasoningEffort: "high",
        totalTokens: 2_147_483_648,
        repository: { fullName: `acme/api-${unique}` },
      }] });

    const jobs = await app.request(`/api/jobs?q=${unique}&provider=CODEX`);
    expect(await jobs.json()).toMatchObject({ total: 1, items: [{ id: jobId, reasoningEffort: "high" }] });

    const repositories = await app.request("/api/repositories");
    expect(await repositories.json()).toMatchObject([{ jobs: [{ id: jobId, reasoningEffort: "high" }] }]);
  });

  test("exposes quota waits as active filterable jobs and allows cancellation", async () => {
    removedWorktrees.length = 0;
    const worktreePath = `/worker_data/worktrees/${crypto.randomUUID()}`;
    const waiting = await prisma.job.create({
      data: {
        repositoryId,
        environment: "test",
        issueNumber: 199,
        subjectType: "PULL_REQUEST",
        jobType: "REVIEW",
        issueTitle: `Quota wait ${unique}`,
        issueUrl: `https://github.com/acme/api-${unique}/pull/199`,
        issueBody: "Quota wait",
        status: "WAITING_FOR_QUOTA",
        activePrKey: `${repositoryId}:199:head:REVIEW`,
        branchName: "agent/issue-199",
        baselineCommit: "e".repeat(40),
        pullRequestNumber: 199,
        worktreePath,
        provider: "CODEX",
        model: "gpt-5.6-luna",
        quotaWaitStartedAt: new Date(),
        quotaResetAt: new Date(Date.now() + 60_000),
        quotaWindow: "codex:primary",
        quotaUsedPercent: 100,
        quotaMessage: "Codex quota exhausted",
      },
    });
    await prisma.review.create({
      data: {
        jobId: waiting.id,
        provider: "CODEX",
        model: "gpt-5.6-luna",
        status: "RUNNING",
        startedAt: new Date(Date.now() - 5_000),
      },
    });

    const dashboard = await (await app.request("/api/dashboard")).json();
    expect(dashboard.jobs.WAITING_FOR_QUOTA).toBe(1);
    expect(dashboard.activeJobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: waiting.id, status: "WAITING_FOR_QUOTA" })]));

    const filtered = await app.request("/api/jobs?status=WAITING_FOR_QUOTA");
    expect(await filtered.json()).toMatchObject({ total: 1, items: [{ id: waiting.id, status: "WAITING_FOR_QUOTA", quotaWindow: "codex:primary" }] });

    const cancelled = await app.request(`/api/jobs/${waiting.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({
      status: "CANCELLED",
      activePrKey: null,
      quotaWaitStartedAt: null,
      worktreeCleanupRequired: false,
    });
    expect(removedWorktrees).toEqual([worktreePath]);
    expect(await prisma.review.findUniqueOrThrow({ where: { jobId: waiting.id } })).toMatchObject({
      status: "FAILED",
      errorMessage: expect.stringContaining("cancelled"),
    });
  });

  test("returns only the five most recent jobs on the dashboard", async () => {
    const jobIds = Array.from({ length: 6 }, (_, index) => `dashboard-${unique}-${index}`);
    await prisma.job.createMany({
      data: jobIds.map((id, index) => ({
        id,
        repositoryId,
        environment: "test",
        issueNumber: 200 + index,
        issueTitle: `Dashboard job ${index}`,
        issueUrl: `https://github.com/acme/api-${unique}/issues/${200 + index}`,
        issueBody: "Dashboard history",
        status: "COMPLETED" as const,
        branchName: `agent/issue-${200 + index}`,
        baselineCommit: "d".repeat(40),
        provider: "CODEX" as const,
        model: "gpt-5.6-luna",
        createdAt: new Date(Date.UTC(2100, 0, index + 1)),
      })),
    });

    const dashboard = await (await app.request("/api/dashboard")).json();

    expect(dashboard.recentJobs.map((job: { id: string }) => job.id)).toEqual(jobIds.slice(1).reverse());
  });

  test("clears resolved dashboard exceptions without hiding live state or deleting history", async () => {
    const failedJob = await prisma.job.create({
      data: {
        repositoryId,
        environment: "test",
        issueNumber: 100,
        issueTitle: `Resolved failure ${unique}`,
        issueUrl: `https://github.com/acme/api-${unique}/issues/100`,
        issueBody: "Failure body",
        status: "FAILED",
        branchName: "agent/issue-100",
        baselineCommit: "b".repeat(40),
        provider: "CODEX",
        model: "gpt-5.6-luna",
        completedAt: new Date(Date.now() - 1_000),
        errorMessage: "The old failure was handled",
      },
    });
    await prisma.jobEvent.create({
      data: { jobId: failedJob.id, repositoryId, type: "JOB_FAILED", message: "Failure evidence" },
    });
    await prisma.repository.update({ where: { id: repositoryId }, data: { status: "INVALID", errorMessage: "Still invalid" } });

    const before = await (await app.request("/api/dashboard")).json();
    expect(before.exceptionJobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: failedJob.id, status: "FAILED" })]));

    const cleared = await app.request("/api/dashboard/exceptions/clear", { method: "POST" });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ exceptionJobs: [] });

    const after = await (await app.request("/api/dashboard")).json();
    expect(after.exceptionJobs).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: failedJob.id })]));
    expect(after.repositories).toEqual(expect.arrayContaining([expect.objectContaining({ id: repositoryId, status: "INVALID" })]));

    const retained = await app.request(`/api/jobs/${failedJob.id}`);
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({ id: failedJob.id, status: "FAILED", events: [expect.objectContaining({ message: "Failure evidence" })] });

    const newFailure = await prisma.job.create({
      data: {
        repositoryId,
        environment: "test",
        issueNumber: 101,
        issueTitle: `New failure ${unique}`,
        issueUrl: `https://github.com/acme/api-${unique}/issues/101`,
        issueBody: "New failure body",
        status: "STALE",
        branchName: "agent/issue-101",
        baselineCommit: "c".repeat(40),
        provider: "CODEX",
        model: "gpt-5.6-luna",
        completedAt: new Date(Date.now() + 1_000),
      },
    });
    const withNewFailure = await (await app.request("/api/dashboard")).json();
    expect(withNewFailure.exceptionJobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: newFailure.id, status: "STALE" })]));

    expect(await prisma.dashboardExceptionAcknowledgement.findUnique({ where: { environment: "test" } })).toMatchObject({ environment: "test" });
    expect(await prisma.dashboardExceptionAcknowledgement.findUnique({ where: { environment: "production" } })).toBeNull();
    await prisma.repository.update({ where: { id: repositoryId }, data: { status: "READY", errorMessage: null } });
  });

  test("returns the repository PR URL instead of an agent-provided URL", async () => {
    await prisma.job.update({
      where: { id: jobId },
      data: { pullRequestNumber: 99, pullRequestUrl: "https://github.com/[REDACTED]/wrong/pull/99" },
    });
    const detail = await app.request(`/api/jobs/${jobId}`);
    expect(await detail.json()).toMatchObject({
      pullRequestUrl: `https://github.com/acme/api-${unique}/pull/99`,
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 400,
        outputTokens: 120,
        reasoningOutputTokens: 80,
        totalTokens: 2_147_483_648,
      },
    });
  });

  test("persists runtime settings and never returns Telegram secrets", async () => {
    const response = await app.request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheduleCron: "*/30 * * * *",
        maxParallelJobs: 2,
        createDiagnosticIssues: true,
        codexCodingModel: "gpt-5.6-api-coding",
        codexReviewModel: "gpt-5.6-api-review",
        codexCodingReasoningEffort: "low",
        codexReviewReasoningEffort: "high",
        telegramEnabled: false,
        telegramBotToken: "telegram-secret-token",
        telegramChatId: "telegram-chat-id",
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("telegram-secret-token");
    expect(body).not.toContain("telegram-chat-id");
    expect(JSON.parse(body)).toMatchObject({
      createDiagnosticIssues: true,
      codexCodingModel: "gpt-5.6-api-coding",
      codexReviewModel: "gpt-5.6-api-review",
      codexCodingReasoningEffort: "low",
      codexReviewReasoningEffort: "high",
    });
    expect(await prisma.runtimeSetting.findMany({ where: { environment: "test" } }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "CODEX_CODING_MODEL", value: "gpt-5.6-api-coding" }),
        expect.objectContaining({ key: "CODEX_REVIEW_MODEL", value: "gpt-5.6-api-review" }),
        expect.objectContaining({ key: "CODEX_CODING_REASONING_EFFORT", value: "low" }),
        expect.objectContaining({ key: "CODEX_REVIEW_REASONING_EFFORT", value: "high" }),
      ]));
    expect(await prisma.runtimeSetting.findMany({ where: { environment: "test" } }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "TELEGRAM_BOT_TOKEN", secret: true }),
        expect.objectContaining({ key: "TELEGRAM_CHAT_ID", secret: true }),
      ]));
    const secretRows = await prisma.runtimeSetting.findMany({
      where: { environment: "test", key: { in: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] } },
    });
    expect(secretRows.every(({ value }) => !value.includes("telegram-secret-token") && !value.includes("telegram-chat-id"))).toBe(true);
  });

  test("cancels and retries the same durable job without invoking the scanner", async () => {
    expect((await app.request(`/api/jobs/${jobId}/cancel`, { method: "POST" })).status).toBe(200);
    expect(labels).toEqual(["bug"]);
    const retry = await app.request(`/api/jobs/${jobId}/retry`, { method: "POST" });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ jobId, status: "QUEUED", sessionResumed: false });
    expect(labels).toEqual(["bug", config.ISSUE_WORKING_LABEL]);
    expect(enqueuedJobs).toEqual([jobId]);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("QUEUED");
    expect((await app.request(`/api/jobs/${jobId}/retry`, { method: "POST" })).status).toBe(409);
  });

  test("uses the manual scanner and rejects Telegram tests while disabled", async () => {
    expect((await app.request("/api/scans/run", { method: "POST" })).status).toBe(202);
    expect(scanCalls).toBe(1);
    expect((await app.request("/api/notifications/test", { method: "POST" })).status).toBe(409);
  });

  test("retry after a terminal failure requeues the job directly", async () => {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "FAILED", activeIssueKey: null, attempts: 1, sessionId: "api-session" },
    });
    labels.splice(0, labels.length, "bug", config.ISSUE_BLOCKED_LABEL);
    const retry = await app.request(`/api/jobs/${jobId}/retry`, { method: "POST" });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ jobId, status: "QUEUED", sessionResumed: true });
    expect(labels).toEqual(["bug", config.ISSUE_WORKING_LABEL]);
    expect(enqueuedJobs).toEqual([jobId, jobId]);
    expect(await prisma.jobEvent.findFirst({ where: { jobId, type: "JOB_RESUME_REQUESTED" }, orderBy: { createdAt: "desc" } }))
      .toMatchObject({ metadata: expect.objectContaining({ attempt: 2, sessionId: "api-session", sessionResumed: true }) });
  });

  test("rejects a stale pull request retry and restores its current review trigger", async () => {
    const managed = await prisma.managedPullRequest.create({
      data: {
        repositoryId,
        prNumber: 456,
        issueNumber: 456,
        issueTitle: "Pull request retry",
        issueUrl: `https://github.com/acme/api-${unique}/issues/456`,
        headBranch: "agent/issue-456",
        headSha: "a".repeat(40),
        baseBranch: "develop",
        workflow: "REVIEW_REQUESTED",
      },
    });
    const stale = await prisma.job.create({
      data: {
        repositoryId,
        environment: "test",
        jobType: "REVIEW",
        subjectType: "PULL_REQUEST",
        issueNumber: 456,
        issueTitle: "Pull request retry",
        issueUrl: `https://github.com/acme/api-${unique}/issues/456`,
        issueBody: "Review this pull request",
        status: "FAILED",
        branchName: "agent/issue-456",
        baselineCommit: "b".repeat(40),
        pullRequestId: managed.id,
        pullRequestNumber: 456,
        pullRequestUrl: "https://github.com/acme/api-test/pull/456",
        headSha: "a".repeat(40),
        provider: "CODEX",
        model: "gpt-5.6-luna",
        activePrKey: `${repositoryId}:${managed.id}:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:REVIEW`,
      },
    });
    pullRequestHead = "c".repeat(40);
    pullRequestLabels.splice(0, pullRequestLabels.length, "bug");

    const retry = await app.request(`/api/jobs/${stale.id}/retry`, { method: "POST" });

    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ error: "Pull request head changed; retry was not queued" });
    expect(pullRequestLabels).toEqual(["bug", config.PR_REVIEW_REQUESTED_LABEL]);
    expect(enqueuedJobs).not.toContain(stale.id);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ status: "FAILED", headSha: "a".repeat(40) });
    pullRequestHead = "a".repeat(40);
  });

  test("creates one sanitized support issue for a failed job and rejects non-failed jobs", async () => {
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        errorMessage: "Provider failed with test-token",
        diagnostics: {
          stage: "provider_process",
          role: "issue-worker",
          provider: "codex",
          model: "test-model",
          sessionId: "session-1",
          exitCode: 1,
          error: "Provider failed with test-token",
          causeChain: ["Provider failed with test-token"],
          stderr: "command --token test-token",
          stack: "Error: Provider failed with test-token\n    at runProvider (worker.ts:42:7)",
          events: [{ type: "COMMAND_FAILED", timestamp: "2026-08-20T12:00:00Z", message: "bun test" }],
        },
      },
    });

    const created = await app.request(`/api/jobs/${jobId}/support-issue`, { method: "POST" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      status: "created",
      issueNumber: 123,
      issueUrl: "https://github.com/acme/api-test/issues/123",
    });
    expect(createdIssues).toHaveLength(1);
    expect(createdIssues[0]).toMatchObject({
      title: expect.stringContaining("Provider failed"),
      labels: [config.ISSUE_READY_LABEL],
    });
    expect(createdIssues[0]?.body).toContain("Provider failed with [REDACTED]");
    expect(createdIssues[0]?.body).toContain("at runProvider (worker.ts:42:7)");
    expect(createdIssues[0]?.body).toContain("Job ID");
    expect(createdIssues[0]?.body).toContain("COMMAND_FAILED");
    expect(createdIssues[0]?.body).not.toContain("test-token");

    const duplicate = await app.request(`/api/jobs/${jobId}/support-issue`, { method: "POST" });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({
      status: "existing",
      issueNumber: 123,
      issueUrl: "https://github.com/acme/api-test/issues/123",
    });
    expect(createdIssues).toHaveLength(1);

    await prisma.job.update({ where: { id: jobId }, data: { status: "COMPLETED" } });
    const notFailed = await app.request(`/api/jobs/${jobId}/support-issue`, { method: "POST" });
    expect(notFailed.status).toBe(409);
    expect(await notFailed.json()).toEqual({ error: "Only failed jobs can create support issues" });

    await prisma.job.update({
      where: { id: jobId },
      data: { status: "FAILED", supportIssueNumber: null, supportIssueUrl: null, supportIssueCreating: false },
    });
    createIssueError = new Error("GitHub is unavailable");
    const failedCreation = await app.request(`/api/jobs/${jobId}/support-issue`, { method: "POST" });
    expect(failedCreation.status).toBe(502);
    expect(await failedCreation.json()).toEqual({ error: "Could not create support issue: GitHub is unavailable" });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: jobId } }))
      .toMatchObject({ status: "FAILED", supportIssueNumber: null, supportIssueUrl: null, supportIssueCreating: true, supportIssueReconcileRequired: true });
  });

  test("reconciles an issue when GitHub commits before the create response fails", async () => {
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        supportIssueNumber: null,
        supportIssueUrl: null,
        supportIssueCreating: false,
        supportIssueReconcileRequired: false,
        errorMessage: "Ambiguous GitHub failure",
      },
    });
    createdIssues.splice(0);
    createIssueError = undefined;
    throwAfterIssueCreation = true;
    reconciledIssue = undefined;
    findIssueCalls = 0;

    try {
      const failedCreation = await app.request(`/api/jobs/${jobId}/support-issue`, { method: "POST" });
      expect(failedCreation.status).toBe(502);
      expect(createdIssues).toHaveLength(1);

      throwAfterIssueCreation = false;
      reconciledIssue = { number: 123, url: "https://github.com/acme/api-test/issues/123" };
      const retry = await app.request(`/api/jobs/${jobId}/support-issue`, { method: "POST" });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({
        status: "existing",
        issueNumber: 123,
        issueUrl: "https://github.com/acme/api-test/issues/123",
      });
      expect(findIssueCalls).toBe(1);
      expect(createdIssues).toHaveLength(1);
    } finally {
      createIssueError = undefined;
      throwAfterIssueCreation = false;
      reconciledIssue = undefined;
      findIssueCalls = 0;
    }
  });

  test("serializes automatic support orchestration with the manual endpoint", async () => {
    const { createSupportIssue } = await import("../src/support-issues/service.ts");
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        supportIssueNumber: null,
        supportIssueUrl: null,
        supportIssueCreating: false,
        errorMessage: "Automatic failure",
      },
    });
    config.CREATE_DIAGNOSTIC_ISSUES = true;
    createIssueError = undefined;
    createdIssues.splice(0);
    let started!: () => void;
    const automaticStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const releaseAutomatic = new Promise<void>((resolve) => { release = resolve; });
    beforeCreateIssue = async () => {
      started();
      await releaseAutomatic;
    };
    const github = {
      createIssue: async (_repository: string, title: string, body: string, issueLabels: string[]) => {
        await beforeCreateIssue?.();
        createdIssues.push({ title, body, labels: issueLabels });
        return { number: 123, url: "https://github.com/acme/api-test/issues/123" };
      },
      findIssueByMarker: async () => undefined,
    };

    try {
      const automatic = createSupportIssue({ config, github, jobId });
      await automaticStarted;
      const manual = await app.request(`/api/jobs/${jobId}/support-issue`, { method: "POST" });
      expect(manual.status).toBe(409);
      release();
      expect(await automatic).toMatchObject({ kind: "created" });
      expect(createdIssues).toHaveLength(1);
      expect(await prisma.job.findUniqueOrThrow({ where: { id: jobId } }))
        .toMatchObject({ status: "FAILED", supportIssueNumber: 123, supportIssueUrl: "https://github.com/acme/api-test/issues/123", supportIssueCreating: false });
    } finally {
      beforeCreateIssue = undefined;
      afterCreateIssue = undefined;
      config.CREATE_DIAGNOSTIC_ISSUES = false;
    }
  });

  test("renews a live support issue claim during a long GitHub request", async () => {
    const { createSupportIssue } = await import("../src/support-issues/service.ts");
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        supportIssueNumber: null,
        supportIssueUrl: null,
        supportIssueCreating: false,
        errorMessage: "Long-running failure",
      },
    });
    createdIssues.splice(0);
    let started!: () => void;
    const creationStarted = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const creationFinished = new Promise<void>((resolve) => { finish = resolve; });
    const github = {
      createIssue: async () => {
        started();
        await creationFinished;
        createdIssues.push({ title: "long request", body: "body", labels: [] });
        return { number: 123, url: "https://github.com/acme/api-test/issues/123" };
      },
      findIssueByMarker: async () => undefined,
    };

    const creating = createSupportIssue({
      config,
      github,
      jobId,
      leaseMs: 100,
      leaseRenewalIntervalMs: 10,
    });
    await creationStarted;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const concurrent = await createSupportIssue({ config, github, jobId, leaseMs: 100, leaseRenewalIntervalMs: 10 });
    expect(concurrent).toMatchObject({ kind: "in_progress" });
    finish();
    expect(await creating).toMatchObject({ kind: "created" });
    expect(createdIssues).toHaveLength(1);
  });

  test("reconciles a created issue when persistence fails", async () => {
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        supportIssueNumber: null,
        supportIssueUrl: null,
        supportIssueCreating: false,
      },
    });
    createdIssues.splice(0);
    reconciledIssue = undefined;
    afterCreateIssue = async () => {
      await prisma.job.update({ where: { id: jobId }, data: { status: "COMPLETED" } });
    };

    try {
      const failed = await app.request(`/api/jobs/${jobId}/support-issue`, { method: "POST" });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "Support issue was created but could not be recorded" });
      expect(await prisma.job.findUniqueOrThrow({ where: { id: jobId } }))
        .toMatchObject({ status: "COMPLETED", supportIssueNumber: null, supportIssueUrl: null, supportIssueCreating: true });

      reconciledIssue = { number: 123, url: "https://github.com/acme/api-test/issues/123" };
      await prisma.job.update({ where: { id: jobId }, data: { status: "FAILED" } });
      afterCreateIssue = undefined;
      const recovered = await app.request(`/api/jobs/${jobId}/support-issue`, { method: "POST" });
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({
        status: "existing",
        issueNumber: 123,
        issueUrl: "https://github.com/acme/api-test/issues/123",
      });
      expect(createdIssues).toHaveLength(1);
      expect(await prisma.job.findUniqueOrThrow({ where: { id: jobId } }))
        .toMatchObject({ status: "FAILED", supportIssueNumber: 123, supportIssueUrl: "https://github.com/acme/api-test/issues/123", supportIssueCreating: false });
    } finally {
      beforeCreateIssue = undefined;
      afterCreateIssue = undefined;
      reconciledIssue = undefined;
    }
  });
  test("removes an obsolete repository together with its events and job history", async () => {
    const obsolete = await prisma.repository.create({
      data: { fullName: `acme/obsolete-${unique}`, cloneUrl: `https://github.com/acme/obsolete-${unique}.git` },
    });
    await prisma.jobEvent.create({
      data: { type: "SCAN_STARTED", message: "Obsolete scan", repositoryId: obsolete.id },
    });
    const obsoleteJob = await prisma.job.create({
      data: {
        repositoryId: obsolete.id,
        environment: "test",
        issueNumber: 55,
        issueTitle: "Obsolete",
        issueUrl: `https://github.com/acme/obsolete-${unique}/issues/55`,
        issueBody: "Body",
        status: "COMPLETED",
        branchName: "agent/issue-55",
        baselineCommit: "c".repeat(40),
        provider: "CODEX",
        model: "gpt-5.6-luna",
      },
    });
    await prisma.jobEvent.create({
      data: { type: "JOB_COMPLETED", message: "Obsolete job", jobId: obsoleteJob.id, repositoryId: obsolete.id },
    });
    await prisma.review.create({
      data: {
        jobId: obsoleteJob.id,
        provider: "CODEX",
        model: "gpt-5.6-luna",
        status: "PASSED",
        response: "ok",
      },
    });
    const listBefore = (await (await app.request("/api/repositories")).json()) as Array<{ id: string }>;
    expect(listBefore.some((repository) => repository.id === obsolete.id)).toBe(true);

    const removed = await app.request(`/api/repositories/${obsolete.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ status: "removed" });

    const repositories = (await (await app.request("/api/repositories")).json()) as Array<{ id: string }>;
    expect(repositories.some((repository) => repository.id === obsolete.id)).toBe(false);
    expect(await prisma.repository.findUnique({ where: { id: obsolete.id } })).toBeNull();
    expect(await prisma.job.count({ where: { repositoryId: obsolete.id } })).toBe(0);
    expect(await prisma.jobEvent.count({ where: { repositoryId: obsolete.id } })).toBe(0);
    expect(await prisma.review.count({ where: { job: { repositoryId: obsolete.id } } })).toBe(0);
  });

  test("blocks removal while jobs are active and reports unknown repositories", async () => {
    const active = await prisma.repository.create({
      data: { fullName: `acme/active-${unique}`, cloneUrl: `https://github.com/acme/active-${unique}.git` },
    });
    await prisma.job.create({
      data: {
        repositoryId: active.id,
        environment: "test",
        issueNumber: 77,
        issueTitle: "Active",
        issueUrl: `https://github.com/acme/active-${unique}/issues/77`,
        issueBody: "Body",
        status: "QUEUED",
        branchName: "agent/issue-77",
        baselineCommit: "d".repeat(40),
        provider: "CODEX",
        model: "gpt-5.6-luna",
      },
    });

    const blocked = await app.request(`/api/repositories/${active.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining("active job") });
    expect(await prisma.repository.findUnique({ where: { id: active.id } })).not.toBeNull();

    const missing = await app.request(`/api/repositories/${crypto.randomUUID()}`, { method: "DELETE" });
    expect(missing.status).toBe(404);
  });

  test("drops a removed repository from the persisted configuration and restarts the scheduler", async () => {
    const configured = await prisma.repository.create({
      data: { fullName: `acme/configured-${unique}`, cloneUrl: `https://github.com/acme/configured-${unique}.git` },
    });
    const patched = await app.request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubRepositories: `acme/api-test,acme/configured-${unique}` }),
    });
    expect(patched.status).toBe(200);
    expect(config.githubRepositories).toContain(`acme/configured-${unique}`);

    const restartsBefore = restartCalls;
    const removed = await app.request(`/api/repositories/${configured.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ status: "removed" });

    expect(config.githubRepositories).toEqual(["acme/api-test"]);
    expect(await prisma.runtimeSetting.findUnique({
      where: { environment_key: { environment: "test", key: "GITHUB_REPOSITORIES" } },
    })).toMatchObject({ value: "acme/api-test" });
    expect(restartCalls).toBeGreaterThan(restartsBefore);
    expect(await prisma.repository.findUnique({ where: { id: configured.id } })).toBeNull();
  });

  test("allows removing the last configured repository and clears the persisted setting", async () => {
    const last = await prisma.repository.create({
      data: { fullName: `acme/last-${unique}`, cloneUrl: `https://github.com/acme/last-${unique}.git` },
    });
    const patched = await app.request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubRepositories: `acme/last-${unique}` }),
    });
    expect(patched.status).toBe(200);
    expect(config.githubRepositories).toEqual([`acme/last-${unique}`]);

    const restartsBefore = restartCalls;
    const removed = await app.request(`/api/repositories/${last.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);

    expect(config.githubRepositories).toEqual(["acme/api-test"]);
    expect(await prisma.runtimeSetting.findUnique({
      where: { environment_key: { environment: "test", key: "GITHUB_REPOSITORIES" } },
    })).toBeNull();
    expect(restartCalls).toBe(restartsBefore + 1);
  });
});

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
  let restartCalls = 0;
  let version = "";
  const unique = crypto.randomUUID();
  const apiJobId = crypto.randomUUID();
  const labels = ["bug", "agent:working"];
  const createdIssues: Array<{ title: string; body: string; labels: string[] }> = [];
  let createIssueError: Error | undefined;
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
        queueJobId: apiJobId,
        branchName: "agent/issue-99",
        baselineCommit: "a".repeat(40),
        provider: "CODEX",
        model: "gpt-5.6-luna",
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
          createdIssues.push({ title, body, labels: issueLabels });
          return { number: 123, url: "https://github.com/acme/api-test/issues/123" };
        },
        addIssueComment: async () => {},
        getPullRequestLabels: async () => [],
        setPullRequestLabels: async () => {},
      },
      queue: { health: async () => "PONG", remove: async () => true },
      settings: createSettingsService(config),
      scheduler: { restart: () => { restartCalls += 1; } },
    });
  });

  afterAll(async () => {
    await prisma.jobEvent.deleteMany({ where: { repositoryId } });
    await prisma.job.deleteMany({ where: { repositoryId } });
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
    expect(statusBody).toMatchObject({ version });
    expect(JSON.stringify(statusBody)).not.toContain("test-token");

    await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: new Date() } });
    expect(await (await app.request("/api/dashboard")).json())
      .toMatchObject({ activeJobs: [{ id: jobId, repository: { fullName: `acme/api-${unique}` } }] });

    const jobs = await app.request(`/api/jobs?q=${unique}&provider=CODEX`);
    expect(await jobs.json()).toMatchObject({ total: 1, items: [{ id: jobId }] });
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
        queueJobId: crypto.randomUUID(),
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
        queueJobId: crypto.randomUUID(),
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
        telegramEnabled: false,
        telegramBotToken: "telegram-secret-token",
        telegramChatId: "telegram-chat-id",
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("telegram-secret-token");
    expect(body).not.toContain("telegram-chat-id");
    expect(JSON.parse(body)).toMatchObject({ createDiagnosticIssues: true });
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

  test("cancels and retries through GitHub before invoking the shared scanner", async () => {
    expect((await app.request(`/api/jobs/${jobId}/cancel`, { method: "POST" })).status).toBe(200);
    expect(labels).toEqual(["bug"]);
    const retry = await app.request(`/api/jobs/${jobId}/retry`, { method: "POST" });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ scanId: "scan-1", scanStatus: "COMPLETED" });
    expect(labels).toEqual(["bug", "agent:ready"]);
  });

  test("uses the manual scanner and rejects Telegram tests while disabled", async () => {
    expect((await app.request("/api/scans/run", { method: "POST" })).status).toBe(202);
    expect(scanCalls).toBe(2);
    expect((await app.request("/api/notifications/test", { method: "POST" })).status).toBe(409);
  });

  test("retry after a terminal failure restores the ready label", async () => {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "FAILED", activeIssueKey: null },
    });
    labels.splice(0, labels.length, "bug", config.ISSUE_BLOCKED_LABEL);
    const retry = await app.request(`/api/jobs/${jobId}/retry`, { method: "POST" });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ scanId: "scan-3", scanStatus: "COMPLETED" });
    expect(labels).toEqual(["bug", config.ISSUE_READY_LABEL]);
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
      .toMatchObject({ status: "FAILED", supportIssueNumber: null, supportIssueUrl: null, supportIssueCreating: false });
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
        queueJobId: crypto.randomUUID(),
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
        queueJobId: crypto.randomUUID(),
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

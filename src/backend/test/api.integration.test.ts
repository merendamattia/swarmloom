import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseConfig } from "../src/core/config-schema.ts";
import { artifactDirectory } from "../src/runner/visual.ts";

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("operations API", () => {
  let prisma: typeof import("../src/core/db.ts").prisma;
  let app: ReturnType<typeof import("../src/api/app.ts").createApp>;
  let repositoryId = "";
  let jobId = "";
  let scanCalls = 0;
  const unique = crypto.randomUUID();
  const apiJobId = crypto.randomUUID();
  const labels = ["bug", "agent:working"];
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
      startup: { providerVersion: "test" },
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
        addIssueComment: async () => {},
      },
      queue: { health: async () => "PONG", remove: async () => true },
      settings: createSettingsService(config),
      scheduler: { restart: () => {} },
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
    expect(await health.json()).toMatchObject({ status: "ok", database: "ok", provider: "codex" });

    const status = await app.request("/api/status");
    expect(JSON.stringify(await status.json())).not.toContain("test-token");

    await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: new Date() } });
    expect(await (await app.request("/api/dashboard")).json())
      .toMatchObject({ activeJobs: [{ id: jobId, repository: { fullName: `acme/api-${unique}` } }] });

    const jobs = await app.request(`/api/jobs?q=${unique}&provider=CODEX`);
    expect(await jobs.json()).toMatchObject({ total: 1, items: [{ id: jobId }] });
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
        telegramEnabled: false,
        telegramBotToken: "telegram-secret-token",
        telegramChatId: "telegram-chat-id",
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("telegram-secret-token");
    expect(body).not.toContain("telegram-chat-id");
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

  test("serves only real artifact PNGs for jobs in the current environment", async () => {
    const directory = artifactDirectory(config.DATA_DIR, jobId);
    const fileName = "0123456789abcdef0123456789abcdef.png";
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, fileName), "png-bytes");
    try {
      const served = await app.request(`/api/artifacts/${jobId}/${fileName}`);
      expect(served.status).toBe(200);
      expect(served.headers.get("Content-Type")).toBe("image/png");
      expect(await served.text()).toBe("png-bytes");

      expect((await app.request(`/api/artifacts/${jobId}/not-hex.png`)).status).toBe(404);
      expect((await app.request(`/api/artifacts/${jobId}/../missing.png`)).status).toBe(404);
      expect((await app.request(`/api/artifacts/${"f".repeat(20)}/${fileName}`)).status).toBe(404);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { createTelegramNotifier } from "../src/notifications/telegram.ts";

describe("Telegram notifier", () => {
  test("sends escaped event text without exposing its token in errors", async () => {
    const requests: Request[] = [];
    const notifier = createTelegramNotifier({
      token: "secret-token",
      chatId: "123",
      dashboardUrl: "http://localhost:18420",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true });
      },
    });
    await notifier.send({
      type: "JOB_COMPLETED",
      message: "Done <safely>",
      id: "event-1",
      jobId: "job-1",
      metadata: {
        issueUrl: "https://github.com/acme/api/issues/7",
        pullRequestUrl: "https://github.com/acme/api/pull/8",
      },
    });
    expect(await requests[0].json()).toEqual({
      chat_id: "123",
      text: "✅ <b>Job completed</b>\nDone &lt;safely&gt;\n\n🔗 <a href=\"https://github.com/acme/api/issues/7\">Issue</a> · <a href=\"https://github.com/acme/api/pull/8\">Pull request</a> · <a href=\"http://localhost:18420/jobs/job-1\">Dashboard</a>",
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

    const failing = createTelegramNotifier({
      token: "secret-token",
      chatId: "123",
      fetch: async () => new Response("secret-token invalid", { status: 401 }),
    });
    expect(failing.send({ type: "TEST", message: "test", id: "event-2" }))
      .rejects.toThrow("[REDACTED]");
  });

  test("appends compact pull request details to completion and opened events", async () => {
    const request = await telegramRequest({
      type: "JOB_COMPLETED",
      message: "Completed acme/api#7 with PR #8 using codex/gpt-5.6-luna in 120s",
      id: "event-3",
      jobId: "job-3",
      metadata: {
        issueUrl: "https://github.com/acme/api/issues/7",
        pullRequestUrl: "https://github.com/acme/api/pull/8",
        pullRequestNumber: 8,
        pullRequestTitle: "Fix queue <durability>",
        pullRequestBody: "Closes #7.\n\nMakes the queue durable in PostgreSQL.",
        filesChanged: 2,
        additions: 120,
        deletions: 45,
      },
    });

    expect(request).toMatchObject({
      chat_id: "123",
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    expect(request.text).toContain("✅ <b>Job completed</b>");
    expect(request.text).toContain("<b>PR #8:</b> Fix queue &lt;durability&gt;");
    expect(request.text).toContain("+120 · -45 · 2 files");
    expect(request.text).toContain("Closes #7. Makes the queue durable in PostgreSQL.");
    expect(request.text).toContain("<a href=\"https://github.com/acme/api/issues/7\">Issue</a>");
    expect(request.text).toContain("<a href=\"https://github.com/acme/api/pull/8\">Pull request</a>");
  });

  test("omits pull request details when metadata lacks a title", async () => {
    const request = await telegramRequest({
      type: "PR_OPENED",
      message: "Opened PR #8 for acme/api#7",
      id: "event-4",
      metadata: { pullRequestUrl: "https://github.com/acme/api/pull/8" },
    });

    expect(request.text).toBe("🔗 <b>Pull request opened</b>\nOpened PR #8 for acme/api#7\n\n🔗 <a href=\"https://github.com/acme/api/pull/8\">Pull request</a>");
  });

  async function telegramRequest(event: Parameters<ReturnType<typeof createTelegramNotifier>["send"]>[0]) {
    const requests: Request[] = [];
    const notifier = createTelegramNotifier({
      token: "secret-token",
      chatId: "123",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true });
      },
    });
    await notifier.send(event);
    return await requests[0].json() as { chat_id: string; text: string; parse_mode: string; disable_web_page_preview: boolean };
  }
});

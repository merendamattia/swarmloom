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
});

import { createEventService } from "../events/service.ts";
import { createGitHubClient } from "../github/client.ts";
import { createTelegramNotifier } from "../notifications/telegram.ts";
import { createScanService } from "../scans/service.ts";
import { createCodexUsageReader } from "../providers/codex-usage.ts";
import type { JobQueue } from "../queue/service.ts";
import type { Config } from "./config-schema.ts";

export function createSharedServices(config: Config, queue: JobQueue) {
  const github = createGitHubClient({ token: config.GITHUB_TOKEN, apiUrl: config.GITHUB_API_URL });
  const notifier = {
    enabled: () => config.TELEGRAM_ENABLED,
    send: (event: Parameters<ReturnType<typeof createTelegramNotifier>["send"]>[0]) => createTelegramNotifier({
      token: config.TELEGRAM_BOT_TOKEN!,
      chatId: config.TELEGRAM_CHAT_ID!,
      dashboardUrl: config.FRONTEND_URL,
    }).send(event),
    sendQueued: (summary: Parameters<ReturnType<typeof createTelegramNotifier>["sendQueued"]>[0]) => createTelegramNotifier({
      token: config.TELEGRAM_BOT_TOKEN!,
      chatId: config.TELEGRAM_CHAT_ID!,
      dashboardUrl: config.FRONTEND_URL,
    }).sendQueued(summary),
  };
  const events = createEventService(notifier);
  const scanner = createScanService({ config, github, events, queue });
  const providerUsage = createCodexUsageReader();
  return { github, events, scanner, providerUsage };
}

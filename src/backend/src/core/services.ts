import { createEventService } from "../events/service.ts";
import { createGitHubClient } from "../github/client.ts";
import { createTelegramNotifier } from "../notifications/telegram.ts";
import { createScanService } from "../scans/service.ts";
import type { JobQueue } from "../queue/service.ts";
import type { Config } from "./config-schema.ts";

export function createSharedServices(config: Config, queue: JobQueue) {
  const github = createGitHubClient({ token: config.GITHUB_TOKEN, apiUrl: config.GITHUB_API_URL });
  const notifier = {
    enabled: () => config.TELEGRAM_ENABLED,
    send: (event: Parameters<ReturnType<typeof createTelegramNotifier>["send"]>[0]) => createTelegramNotifier({
      token: config.TELEGRAM_BOT_TOKEN!,
      chatId: config.TELEGRAM_CHAT_ID!,
    }).send(event),
  };
  const events = createEventService(notifier);
  const scanner = createScanService({ config, github, events, queue });
  return { github, events, scanner };
}

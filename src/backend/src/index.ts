import { createApp } from "./api/app.ts";
import { config } from "./core/config.ts";
import { prisma } from "./core/db.ts";
import { logger } from "./core/logger.ts";
import { createSharedServices } from "./core/services.ts";
import { validateStartup } from "./core/startup.ts";
import { heartbeatRepository } from "./repositories/heartbeats.ts";
import { scanRunRepository } from "./repositories/scan-runs.ts";
import { startScheduler } from "./scheduler/service.ts";
import { createJobQueue } from "./queue/service.ts";
import { createSettingsService } from "./core/settings-service.ts";

const settings = createSettingsService(config);
await settings.initialize();
const startup = await validateStartup(config);
const queue = createJobQueue(config);
await queue.health();
const { github, events, scanner } = createSharedServices(config, queue);
await scanRunRepository.recoverRunning(config.APP_ENV);
const scheduler = startScheduler(config, scanner);
const heartbeat = setInterval(() => {
  void heartbeatRepository.beat("api", config.APP_ENV, config.WORKER_ID, { port: config.PORT });
}, config.HEARTBEAT_INTERVAL_MS);
void heartbeatRepository.beat("api", config.APP_ENV, config.WORKER_ID, { port: config.PORT });

const server = Bun.serve({
  port: config.PORT,
  idleTimeout: 120,
  fetch: createApp({ config, scanner, github, events, startup, queue, settings, scheduler }).fetch,
});
logger.info("API and scheduler started", {
  environment: config.APP_ENV,
  port: server.port,
  provider: config.AGENT_PROVIDER,
  schedule: config.SCHEDULE_CRON,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown());
}

async function shutdown() {
  scheduler.stop();
  clearInterval(heartbeat);
  server.stop(true);
  await queue.close();
  await prisma.$disconnect();
  process.exit(0);
}

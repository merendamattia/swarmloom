import { config } from "./core/config.ts";
import { prisma } from "./core/db.ts";
import { logger } from "./core/logger.ts";
import { createSharedServices } from "./core/services.ts";
import { createSettingsService } from "./core/settings-service.ts";
import { validateStartup } from "./core/startup.ts";
import { createAgentProvider } from "./providers/index.ts";
import { createJobRunner } from "./runner/service.ts";
import { startWorkerLoops } from "./worker/service.ts";
import { createJobQueue } from "./queue/service.ts";
import { recoverStaleJobs } from "./worker/recovery.ts";

const settings = createSettingsService(config);
await settings.initialize();
await validateStartup(config);
process.env.GH_TOKEN = config.GITHUB_TOKEN;
process.env.GIT_AUTHOR_NAME = config.GIT_AUTHOR_NAME;
process.env.GIT_AUTHOR_EMAIL = config.GIT_AUTHOR_EMAIL;
process.env.GIT_COMMITTER_NAME = config.GIT_AUTHOR_NAME;
process.env.GIT_COMMITTER_EMAIL = config.GIT_AUTHOR_EMAIL;
const queue = createJobQueue(config);
await queue.health();
const { github, events, providerUsage } = createSharedServices(config, queue);
const staleJobsRecovered = await recoverStaleJobs(config, github, events);
const providers = {
  codex: createAgentProvider("codex", providerUsage),
  opencode: createAgentProvider("opencode"),
};
const runner = createJobRunner({ config, providers, github, events, queue });
const worker = startWorkerLoops(
  config,
  queue,
  runner,
  settings,
  () => recoverStaleJobs(config, github, events),
  { codex: providerUsage },
  events,
);
logger.info("Worker started", {
  environment: config.APP_ENV,
  provider: config.AGENT_PROVIDER,
  concurrency: config.MAX_PARALLEL_JOBS,
  staleJobsRecovered,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown());
}

async function shutdown() {
  await worker.stop();
  await queue.close();
  await prisma.$disconnect();
  process.exit(0);
}

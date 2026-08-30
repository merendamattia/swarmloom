import type { Config } from "../core/config-schema.ts";
import type { SettingsService } from "../core/settings-service.ts";
import { logger } from "../core/logger.ts";
import { heartbeatRepository } from "../repositories/heartbeats.ts";
import { jobRepository } from "../repositories/jobs.ts";
import type { JobQueue } from "../queue/service.ts";

type Runner = { run(jobId: string, workerId: string, claimToken: string): Promise<boolean> };
type RecoverStaleJobs = () => Promise<number>;

export async function reconcileQueuedJobs(
  environment: string,
  queue: Pick<JobQueue, "enqueueMissing">,
) {
  const queued = await jobRepository.findQueued(environment);
  await queue.enqueueMissing(queued.map((job) => job.id));
  return queued.length;
}

export function startWorkerLoops(
  config: Config,
  queue: JobQueue,
  runner: Runner,
  settings: SettingsService,
  recoverStale?: RecoverStaleJobs,
) {
  const worker = queue.createWorker(async (payload) => {
    if (payload.environment !== config.APP_ENV) return;
    await settings.reload();
    worker.concurrency = config.MAX_PARALLEL_JOBS;
    const claimed = await jobRepository.claim(payload.jobId, config.APP_ENV, config.WORKER_ID);
    if (claimed?.claimToken) await runner.run(claimed.id, config.WORKER_ID, claimed.claimToken);
  }, config.MAX_PARALLEL_JOBS);
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await settings.reload();
      worker.concurrency = config.MAX_PARALLEL_JOBS;
      await beat(config);
      await recoverStale?.();
      await reconcileQueuedJobs(config.APP_ENV, queue);
    } catch (error) {
      logger.error("Worker refresh failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      refreshing = false;
    }
  };
  const refreshInterval = setInterval(() => void refresh(), Math.min(config.HEARTBEAT_INTERVAL_MS, 5_000));
  void refresh();

  async function beat(current: Config) {
    await heartbeatRepository.beat("worker", current.APP_ENV, current.WORKER_ID, {
      provider: current.AGENT_PROVIDER,
      concurrency: current.MAX_PARALLEL_JOBS,
      queue: "bullmq",
    });
  }

  return {
    stop: async () => {
      clearInterval(refreshInterval);
      await worker.close();
    },
  };
}

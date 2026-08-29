import type { Config } from "../core/config-schema.ts";
import type { SettingsService } from "../core/settings-service.ts";
import { logger } from "../core/logger.ts";
import type { EventService } from "../events/service.ts";
import { quotaAdmission } from "../providers/quota.ts";
import type { AgentProvider, ProviderUsageCapability } from "../providers/types.ts";
import { heartbeatRepository } from "../repositories/heartbeats.ts";
import { jobRepository } from "../repositories/jobs.ts";
import type { JobQueue } from "../queue/service.ts";

type Runner = { run(jobId: string, workerId: string): Promise<boolean> };
type RecoverStaleJobs = () => Promise<number>;
type ProviderQuotas = Partial<Record<AgentProvider["name"], ProviderUsageCapability>>;

export function startWorkerLoops(
  config: Config,
  queue: JobQueue,
  runner: Runner,
  settings: SettingsService,
  recoverStale?: RecoverStaleJobs,
  providerQuotas: ProviderQuotas = {},
  events?: EventService,
) {
  const worker = queue.createWorker(async (payload) => {
    if (payload.environment !== config.APP_ENV) return;
    await settings.reload();
    worker.concurrency = config.MAX_PARALLEL_JOBS;
    const queued = await jobRepository.findQueued(payload.jobId, config.APP_ENV);
    if (!queued) return;
    const provider = queued.provider.toLowerCase() as AgentProvider["name"];
    const quota = providerQuotas[provider];
    if (quota) {
      let snapshot;
      try {
        snapshot = await quota.readAccountUsage();
      } catch {
        snapshot = undefined;
      }
      const admission = snapshot ? quotaAdmission(snapshot) : { kind: "allow" as const };
      if (snapshot && admission.kind === "wait") {
        const waiting = await jobRepository.waitForQuotaQueued(payload.jobId, config.APP_ENV, {
          resetAt: admission.resetAt,
          window: admission.window,
          usedPercent: admission.usedPercent,
          message: snapshot.message ?? "Codex quota is exhausted",
        });
        if (waiting) {
          await events?.record({
            type: "JOB_WAITING_FOR_QUOTA",
            message: `Deferred ${provider} job ${payload.jobId} until quota returns`,
            jobId: payload.jobId,
            metadata: {
              quotaResetAt: admission.resetAt,
              quotaWindow: admission.window,
              quotaUsedPercent: admission.usedPercent,
              observedAt: snapshot.observedAt,
            },
          });
        }
        return;
      }
    }
    const claimed = await jobRepository.claim(payload.jobId, config.APP_ENV, config.WORKER_ID);
    if (claimed) await runner.run(claimed.id, config.WORKER_ID);
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

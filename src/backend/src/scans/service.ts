import type { Config } from "../core/config-schema.ts";
import { redactSecrets } from "../core/secrets.ts";
import type { EventService, QueuedJobInfo } from "../events/service.ts";
import type { GitHubClient } from "../github/client.ts";
import { githubGitEnvironment } from "../github/git-auth.ts";
import { agentLabelDefinitions } from "../github/labels.ts";
import { MissingDevelopBranchError, syncRepository as syncTargetRepository } from "../git/repositories.ts";
import { eventRepository } from "../repositories/events.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { repositoryRepository } from "../repositories/repositories.ts";
import { scanRunRepository } from "../repositories/scan-runs.ts";
import type { JobQueue } from "../queue/service.ts";
import { quotaAvailable } from "../providers/quota.ts";
import type { ProviderUsageCapability } from "../providers/types.ts";
import { createIssueScanner } from "./issue-scanner.ts";
import { createPullRequestScanner } from "./pr-scanner.ts";
import type { ScannerShared } from "./common.ts";

type SyncRepository = typeof syncTargetRepository;

type ScanServiceDependencies = {
  config: Config;
  github: ScannerShared["github"];
  events?: EventService;
  queue?: Pick<JobQueue, "enqueue">;
  providerUsage?: ScannerShared["providerUsage"];
  syncRepository?: SyncRepository;
};

export function createScanService({
  config,
  github,
  events = { record: eventRepository.create, notifyQueuedSummary: async () => {} },
  queue = { enqueue: async () => {} },
  providerUsage,
  syncRepository = syncTargetRepository,
}: ScanServiceDependencies) {
  const shared: ScannerShared = {
    config,
    github,
    events,
    queue,
    providerUsage,
  };
  const issueScanner = createIssueScanner(shared);
  const pullRequestScanner = createPullRequestScanner(shared);

  async function run(source: "SCHEDULED" | "MANUAL") {
    const scan = await scanRunRepository.start(config.APP_ENV, source, config.githubRepositories.length);
    if (scan.status === "SKIPPED") return scan;
    let queuedCount = 0;
    const queuedJobs: QueuedJobInfo[] = [];
    try {
      await events.record({
        type: "SCAN_STARTED",
        message: `${source === "SCHEDULED" ? "Scheduled" : "Manual"} scan started for ${config.githubRepositories.length} repositories`,
        scanRunId: scan.id,
        metadata: { source, repositories: config.githubRepositories },
      });
      await reconcileQueuedJobs(scan.id);
      await reconcileWaitingJobs(scan.id);
      for (const fullName of config.githubRepositories) {
        let repository = await repositoryRepository.upsertConfigured(fullName, "");
        try {
          const { cloneUrl } = await github.getRepository(fullName);
          repository = await repositoryRepository.upsertConfigured(fullName, cloneUrl);
          const synced = await syncRepository({
            dataDir: config.DATA_DIR,
            fullName,
            cloneUrl,
            gitEnvironment: githubGitEnvironment(config.GITHUB_TOKEN, cloneUrl),
          });
          await repositoryRepository.markReady(repository.id, synced.localPath, synced.baselineCommit);
          repository = { ...repository, localPath: synced.localPath, baselineCommit: synced.baselineCommit };
          await github.ensureLabels?.(fullName, agentLabelDefinitions(config));
          const pullRequestQueued = await pullRequestScanner.run(repository, fullName, scan.id);
          const issueQueued = await issueScanner.run(repository, fullName, scan.id);
          for (const queued of [...pullRequestQueued, ...issueQueued]) {
            queuedCount += 1;
            queuedJobs.push(queued.info);
          }
        } catch (error) {
          const message = safeError(error);
          if (error instanceof MissingDevelopBranchError) {
            await repositoryRepository.markInvalid(repository.id, message);
            await events.record({
              type: "REPOSITORY_INVALID",
              level: "ERROR",
              message,
              repositoryId: repository.id,
              scanRunId: scan.id,
            });
            continue;
          }
          await repositoryRepository.markError(repository.id, message);
          await events.record({
            type: "REPOSITORY_ERROR",
            level: "ERROR",
            message: `Repository scan failed for ${fullName}: ${message}`,
            repositoryId: repository.id,
            scanRunId: scan.id,
          });
        }
      }
      const discovered = await scanRunRepository.finishDiscovery(scan.id, queuedCount);
      await events.record({
        type: "SCAN_DISCOVERY_COMPLETED",
        message: `Scan found ${queuedCount} new job${queuedCount === 1 ? "" : "s"} across ${config.githubRepositories.length} repositories`,
        scanRunId: scan.id,
        metadata: { source, queuedCount, repositories: config.githubRepositories.length },
      });
      if (queuedJobs.length > 0) {
        await events.notifyQueuedSummary(scan.id, queuedJobs);
      }
      return discovered;
    } catch (error) {
      const message = safeError(error);
      await scanRunRepository.fail(scan.id, message);
      await events.record({
        type: "SCAN_FAILED",
        level: "ERROR",
        message: `Scan failed: ${message}`,
        scanRunId: scan.id,
        metadata: { source },
      });
      throw error;
    }
  }

  return { run };

  async function reconcileQueuedJobs(scanRunId: string) {
    const queued = await jobRepository.findQueuedJobs(config.APP_ENV);
    for (const job of queued) {
      try {
        await queue.enqueue(job.id);
      } catch (error) {
        await events.record({
          type: "QUEUE_RECONCILIATION_REQUIRED",
          level: "ERROR",
          message: `Could not restore BullMQ delivery for ${job.jobType} job ${job.id}: ${safeError(error)}`,
          jobId: job.id,
          repositoryId: job.repositoryId,
          scanRunId,
          metadata: { issueUrl: job.issueUrl, issueNumber: job.issueNumber },
        });
      }
    }
  }

  async function reconcileWaitingJobs(scanRunId: string) {
    if (!providerUsage) return;
    const waiting = await jobRepository.findWaitingForQuota(config.APP_ENV);
    if (waiting.length === 0) return;
    let snapshot;
    try {
      snapshot = await providerUsage.readAccountUsage();
    } catch {
      return;
    }
    if (!quotaAvailable(snapshot)) return;
    await events.record({
      type: "PROVIDER_QUOTA_AVAILABLE",
      message: `Codex quota is available; reconciling ${waiting.length} waiting job${waiting.length === 1 ? "" : "s"}`,
      scanRunId,
      metadata: quotaMetadata(snapshot),
    });
    for (const job of waiting) {
      const requeued = await jobRepository.requeueWaitingForQuota(job.id, config.APP_ENV);
      if (!requeued) continue;
      try {
        await queue.enqueue(requeued.id);
      } catch (error) {
        await jobRepository.waitForQuotaQueued(requeued.id, config.APP_ENV, {
          resetAt: job.quotaResetAt?.toISOString(),
          window: job.quotaWindow,
          usedPercent: job.quotaUsedPercent,
          message: job.quotaMessage,
        });
        await events.record({
          type: "QUEUE_RECONCILIATION_REQUIRED",
          level: "ERROR",
          message: `Could not requeue quota-waiting job ${requeued.id}: ${safeError(error)}`,
          jobId: requeued.id,
          repositoryId: requeued.repositoryId,
          scanRunId,
          metadata: { issueUrl: requeued.issueUrl },
        });
        continue;
      }
      await events.record({
        type: "JOB_QUOTA_RESUME_QUEUED",
        message: `Requeued ${job.jobType} for ${job.repository.fullName}#${job.issueNumber} after Codex quota returned`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId,
        metadata: { issueUrl: job.issueUrl, ...quotaMetadata(snapshot) },
      });
    }
  }
}

function safeError(error: unknown) {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function quotaMetadata(snapshot: Awaited<ReturnType<ProviderUsageCapability["readAccountUsage"]>>) {
  return {
    observedAt: snapshot.observedAt,
    windows: snapshot.windows.map(({ limitId, windowType, remainingPercent, resetsAt }) => ({
      limitId,
      windowType,
      remainingPercent,
      resetsAt,
    })),
  };
}

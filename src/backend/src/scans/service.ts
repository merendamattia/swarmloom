import type { Config } from "../core/config-schema.ts";
import { redactSecrets } from "../core/secrets.ts";
import type { EventService, QueuedJobInfo } from "../events/service.ts";
import type { GitHubClient } from "../github/client.ts";
import { githubGitEnvironment } from "../github/git-auth.ts";
import { agentLabelDefinitions } from "../github/labels.ts";
import { MissingDevelopBranchError, syncRepository as syncTargetRepository } from "../git/repositories.ts";
import { eventRepository } from "../repositories/events.ts";
import { repositoryRepository } from "../repositories/repositories.ts";
import { scanRunRepository } from "../repositories/scan-runs.ts";
import type { JobQueue } from "../queue/service.ts";
import { finishScanIfComplete } from "./finalize.ts";
import { createIssueScanner } from "./issue-scanner.ts";
import { createPullRequestScanner } from "./pr-scanner.ts";
import type { ScannerShared } from "./common.ts";

type SyncRepository = typeof syncTargetRepository;

type ScanServiceDependencies = {
  config: Config;
  github: ScannerShared["github"];
  events?: EventService;
  queue?: Pick<JobQueue, "enqueue">;
  syncRepository?: SyncRepository;
};

export function createScanService({
  config,
  github,
  events = { record: eventRepository.create, notifyQueuedSummary: async () => {} },
  queue = { enqueue: async () => {} },
  syncRepository = syncTargetRepository,
}: ScanServiceDependencies) {
  const shared: ScannerShared = {
    config,
    github,
    events,
    queue,
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
      return await finishScanIfComplete(scan.id, config.APP_ENV, events) ?? discovered;
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
}

function safeError(error: unknown) {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

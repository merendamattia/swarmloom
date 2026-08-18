import type { Config } from "../core/config-schema.ts";
import { redactSecrets } from "../core/secrets.ts";
import type { EventService } from "../events/service.ts";
import type { GitHubClient } from "../github/client.ts";
import { githubGitEnvironment } from "../github/git-auth.ts";
import { agentLabelDefinitions, replaceWorkerLabels } from "../github/labels.ts";
import { MissingDevelopBranchError, syncRepository as syncTargetRepository } from "../git/repositories.ts";
import { eventRepository } from "../repositories/events.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { repositoryRepository } from "../repositories/repositories.ts";
import { scanRunRepository } from "../repositories/scan-runs.ts";
import { configuredAgent } from "../providers/index.ts";
import type { JobQueue } from "../queue/service.ts";
import { finishScanIfComplete } from "./finalize.ts";

type SyncRepository = typeof syncTargetRepository;

type ScanServiceDependencies = {
  config: Config;
  github: Pick<GitHubClient, "getRepository" | "listReadyIssues" | "setIssueLabels"> &
    Partial<Pick<GitHubClient, "ensureLabels">>;
  events?: EventService;
  queue?: Pick<JobQueue, "enqueue">;
  syncRepository?: SyncRepository;
};

export function createScanService({
  config,
  github,
  events = { record: eventRepository.create },
  queue = { enqueue: async () => {} },
  syncRepository = syncTargetRepository,
}: ScanServiceDependencies) {
  async function run(source: "SCHEDULED" | "MANUAL") {
    const scan = await scanRunRepository.start(config.APP_ENV, source, config.githubRepositories.length);
    if (scan.status === "SKIPPED") return scan;
    let queuedCount = 0;
    const agent = configuredAgent(config);
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
          await github.ensureLabels?.(fullName, agentLabelDefinitions(config));
          const issues = await github.listReadyIssues(fullName, config.ISSUE_READY_LABEL);
          for (const issue of issues) {
            const job = await jobRepository.tryCreateQueued({
              repositoryId: repository.id,
              scanRunId: scan.id,
              environment: config.APP_ENV,
              issueNumber: issue.number,
              issueTitle: issue.title,
              issueUrl: issue.url,
              issueBody: issue.body,
              branchName: `agent/issue-${issue.number}-${crypto.randomUUID().slice(0, 8)}`,
              baselineCommit: synced.baselineCommit,
              provider: agent.provider,
              model: agent.model,
              reasoningEffort: agent.reasoningEffort,
            });
            if (!job) continue;
            try {
              await github.setIssueLabels(
                fullName,
                issue.number,
                replaceWorkerLabels(issue.labels, config, [config.ISSUE_WORKING_LABEL]),
              );
              await queue.enqueue(job.id);
              queuedCount += 1;
              await events.record({
                type: "JOB_QUEUED",
                message: `Queued ${fullName}#${issue.number}`,
                jobId: job.id,
                repositoryId: repository.id,
                scanRunId: scan.id,
                metadata: { issueUrl: issue.url, issueNumber: issue.number },
              });
            } catch (error) {
              await jobRepository.failQueued(job.id, safeError(error));
              await events.record({
                type: "JOB_FAILED",
                level: "ERROR",
                message: `Could not acquire ${fullName}#${issue.number} on GitHub`,
                jobId: job.id,
                repositoryId: repository.id,
                scanRunId: scan.id,
                metadata: { issueUrl: issue.url, issueNumber: issue.number },
              });
            }
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

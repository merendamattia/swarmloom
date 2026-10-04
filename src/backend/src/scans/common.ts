import type { Config } from "../core/config-schema.ts";
import type { EventService, QueuedJobInfo } from "../events/service.ts";
import type { GitHubClient } from "../github/client.ts";
import { acquireIssueLabels, replacePullRequestLabels } from "../github/labels.ts";
import { jobRepository, type QueuedJobInput } from "../repositories/jobs.ts";
import type { JobQueue } from "../queue/service.ts";
import type { ProviderUsageCapability } from "../providers/types.ts";
import { redactSecrets } from "../core/secrets.ts";

export type ScannerShared = {
  config: Config;
  github: Pick<GitHubClient,
    "getRepository" | "ensureLabels" | "listReadyIssues" | "getIssue" | "setIssueLabels" | "addIssueComment" |
    "getPullRequest" | "getPullRequestLabels" | "setPullRequestLabels" | "listPullRequests" |
    "compareBranches" | "lastMergedPromotionDate" | "listMergedPullRequests" | "findPromotionPullRequest" |
    "createPromotionPullRequest" | "updatePullRequestBody">;
  events: EventService;
  queue: Pick<JobQueue, "enqueue">;
  providerUsage?: ProviderUsageCapability;
};

export type QueuedResult = {
  jobId: string;
  info: QueuedJobInfo;
};

export async function queueJob(
  shared: ScannerShared,
  fullName: string,
  input: QueuedJobInput,
  scanRunId: string,
): Promise<QueuedResult | null> {
  const { events, queue } = shared;
  const job = await jobRepository.tryCreateQueued({ ...input, scanRunId });
  if (!job) return null;
  try {
    await queue.enqueue(job.id);
  } catch (error) {
    await jobRepository.failQueued(job.id, safeError(error));
    await events.record({
      type: "JOB_FAILED",
      level: "ERROR",
      message: `Could not enqueue job ${job.id} for ${fullName}#${input.issueNumber}`,
      jobId: job.id,
      repositoryId: input.repositoryId,
      scanRunId,
      metadata: { issueUrl: input.issueUrl, issueNumber: input.issueNumber },
    });
    return null;
  }
  return {
    jobId: job.id,
    info: {
      repository: fullName,
      issueNumber: input.issueNumber,
      issueTitle: input.issueTitle,
      issueUrl: input.issueUrl,
      pullRequestNumber: input.pullRequestNumber ?? null,
      jobType: input.jobType,
      jobId: job.id,
    },
  };
}

export function acquireIssue(shared: ScannerShared, fullName: string, issueNumber: number, labels: string[]) {
  return shared.github.setIssueLabels(
    fullName,
    issueNumber,
    acquireIssueLabels(labels, shared.config),
  );
}

export async function transitionPullRequestLabels(
  shared: ScannerShared,
  fullName: string,
  pullRequestNumber: number,
  nextLabels: string[],
) {
  const labels = await shared.github.getPullRequestLabels(fullName, pullRequestNumber);
  await shared.github.setPullRequestLabels(
    fullName,
    pullRequestNumber,
    replacePullRequestLabels(labels, shared.config, nextLabels),
  );
}

export function safeError(error: unknown) {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

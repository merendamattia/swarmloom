import type { EventService } from "../events/service.ts";
import type { GitHubClient } from "../github/client.ts";
import { replaceWorkerLabels } from "../github/labels.ts";
import { redactSecrets } from "../core/secrets.ts";
import type { Config } from "../core/config-schema.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { finishScanIfComplete } from "../scans/finalize.ts";

export async function recoverStaleJobs(config: Config, github: GitHubClient, events: EventService) {
  const staleJobs = await jobRepository.recoverStaleBefore(
    config.APP_ENV,
    new Date(Date.now() - config.STALE_JOB_THRESHOLD_MS),
  );
  for (const job of staleJobs) {
    await events.record({
      type: "JOB_FAILED",
      level: "ERROR",
      message: `Recovered stale job ${job.repository.fullName}#${job.issueNumber} after its heartbeat expired`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: { issueUrl: job.issueUrl },
    });
    try {
      const issue = await github.getIssue(job.repository.fullName, job.issueNumber);
      await github.setIssueLabels(
        job.repository.fullName,
        job.issueNumber,
        replaceWorkerLabels(issue.labels, config, [config.ISSUE_BLOCKED_LABEL]),
      );
      await github.addIssueComment(
        job.repository.fullName,
        job.issueNumber,
        "Worker execution stopped after its heartbeat expired. The job is marked stale and can be retried.",
      );
    } catch (error) {
      await events.record({
        type: "GITHUB_RECONCILIATION_REQUIRED",
        level: "ERROR",
        message: `Could not reconcile stale ${job.repository.fullName}#${job.issueNumber}: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        metadata: { issueUrl: job.issueUrl },
      });
    }
  }
  for (const scanRunId of new Set(staleJobs.flatMap((job) => job.scanRunId ? [job.scanRunId] : []))) {
    await finishScanIfComplete(scanRunId, config.APP_ENV, events);
  }
  return staleJobs.length;
}

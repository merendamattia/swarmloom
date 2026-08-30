import type { EventService } from "../events/service.ts";
import type { GitHubClient } from "../github/client.ts";
import { replacePullRequestLabels, replaceWorkerLabels } from "../github/labels.ts";
import { redactSecrets } from "../core/secrets.ts";
import type { Config } from "../core/config-schema.ts";
import { removeJobWorktree, repositoryPath } from "../git/repositories.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { reviewRepository } from "../repositories/reviews.ts";
import { recoverCancelledWorktrees } from "../worktrees/recovery.ts";

type RemoveWorktree = typeof removeJobWorktree;
type TerminalRecoveryConfig = Pick<Config, "APP_ENV" | "DATA_DIR">;

export async function recoverTerminalJobs(
  config: TerminalRecoveryConfig,
  events: Pick<EventService, "record">,
  removeWorktree: RemoveWorktree = removeJobWorktree,
) {
  const jobs = await jobRepository.findTerminalRecoveryJobs(config.APP_ENV);
  let recovered = 0;

  for (const job of jobs) {
    if (job.status === "FAILED") {
      if (job.cleanupToken && job.worktreePath) {
        const cleanup = await jobRepository.claimFailedWorktreeCleanup(job.id, job.worktreePath);
        if (!cleanup) continue;
        try {
          await removeWorktree({
            worktreePath: cleanup.path,
            repositoryPath: job.repository.localPath ?? repositoryPath(config.DATA_DIR, job.repository.fullName),
            gitEnvironment: undefined,
          });
          if (!await jobRepository.clearWorktree(job.id, null, cleanup.cleanupToken)) continue;
          if (await jobRepository.discardFailedJob(job.id, null)) recovered += 1;
        } catch (error) {
          await events.record({
            type: "WORKTREE_CLEANUP_REQUIRED",
            level: "ERROR",
            message: `Could not remove failed job worktree ${job.worktreePath}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            scanRunId: job.scanRunId ?? undefined,
            metadata: { issueUrl: job.issueUrl },
          });
        }
        continue;
      }
      if (!job.cleanupToken && (job.workerId || job.claimToken)
        && await jobRepository.releaseWorker(job.id, job.workerId, job.claimToken)) {
        recovered += 1;
      }
      continue;
    }
    if (!job.worktreePath) {
      if (!job.cleanupToken && (job.workerId || job.claimToken)
        && await jobRepository.releaseWorker(job.id, job.workerId, job.claimToken)) {
        recovered += 1;
      }
      continue;
    }

    const cleanup = await jobRepository.claimTerminalWorktreeCleanup(job.id, job.worktreePath);
    if (!cleanup) continue;
    try {
      await removeWorktree({
        worktreePath: cleanup.path,
        repositoryPath: job.repository.localPath ?? repositoryPath(config.DATA_DIR, job.repository.fullName),
        gitEnvironment: undefined,
      });
      if (!await jobRepository.clearWorktree(job.id, null, cleanup.cleanupToken)) continue;
      if (await jobRepository.releaseWorker(job.id, null, null)) recovered += 1;
    } catch (error) {
      await events.record({
        type: "WORKTREE_CLEANUP_REQUIRED",
        level: "ERROR",
        message: `Could not remove terminal ${job.jobType} worktree ${job.worktreePath}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl },
      });
    }
  }

  return recovered;
}

export async function recoverStaleJobs(config: Config, github: GitHubClient, events: EventService) {
  await recoverTerminalJobs(config, events);
  await recoverCancelledWorktrees(config, events);
  await reviewRepository.reconcileCancelledJobs();
  const staleJobs = await jobRepository.recoverStaleBefore(
    config.APP_ENV,
    new Date(Date.now() - config.STALE_JOB_THRESHOLD_MS),
  );
  for (const job of staleJobs) {
    let cleanupComplete = !job.worktreePath;
    if (job.worktreePath) {
      try {
        const cleanup = await jobRepository.claimWorktreeCleanup(job.id, job.workerId, job.claimToken, job.worktreePath);
        if (cleanup) {
          await removeJobWorktree({
            worktreePath: cleanup.path,
            repositoryPath: job.repository.localPath ?? repositoryPath(config.DATA_DIR, job.repository.fullName),
            gitEnvironment: undefined,
          });
          cleanupComplete = await jobRepository.clearWorktree(job.id, job.claimToken, cleanup.cleanupToken);
        }
      } catch (error) {
        await events.record({
          type: "WORKTREE_CLEANUP_REQUIRED",
          level: "ERROR",
          message: `Could not remove stale job worktree ${job.worktreePath}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
          jobId: job.id,
          repositoryId: job.repositoryId,
          scanRunId: job.scanRunId ?? undefined,
          metadata: { issueUrl: job.issueUrl },
        });
      }
    }
    if (cleanupComplete) await jobRepository.releaseWorker(job.id, job.workerId, job.claimToken);
    await events.record({
      type: "JOB_FAILED",
      level: "ERROR",
      message: `Recovered stale ${job.jobType} job ${job.repository.fullName}#${job.issueNumber} after its heartbeat expired`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: { issueUrl: job.issueUrl, pullRequestNumber: job.pullRequestNumber ?? undefined },
    });
    try {
      if (job.subjectType === "PULL_REQUEST" && job.pullRequestNumber) {
        const labels = await github.getPullRequestLabels(job.repository.fullName, job.pullRequestNumber);
        const nextLabels = job.jobType === "REVIEW"
          ? [config.PR_REVIEW_REQUESTED_LABEL]
          : [config.PR_FIX_REQUESTED_LABEL];
        await github.setPullRequestLabels(
          job.repository.fullName,
          job.pullRequestNumber,
          replacePullRequestLabels(labels, config, nextLabels),
        );
        await github.addIssueComment(
          job.repository.fullName,
          job.pullRequestNumber,
          "Worker execution stopped after its heartbeat expired. The job is marked stale and the next scan will reschedule the work.",
        );
      } else {
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
      }
    } catch (error) {
      await events.record({
        type: "GITHUB_RECONCILIATION_REQUIRED",
        level: "ERROR",
        message: `Could not reconcile stale ${job.jobType} job for ${job.repository.fullName}#${job.issueNumber}: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        metadata: { issueUrl: job.issueUrl, pullRequestNumber: job.pullRequestNumber ?? undefined },
      });
    }
  }
  return staleJobs.length;
}

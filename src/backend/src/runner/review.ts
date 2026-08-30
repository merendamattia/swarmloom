import { githubGitEnvironment } from "../github/git-auth.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { managedPullRequestRepository } from "../repositories/managed-prs.ts";
import { reviewRepository } from "../repositories/reviews.ts";
import { safeWorktreePath } from "./paths.ts";
import {
  applyPullRequestLabels,
  parseReviewOutcome,
  prepareJobWorktree,
  parseTldr,
  reviewContext,
  safeError,
} from "./helpers.ts";
import { isQuotaFailure } from "./diagnostics.ts";
import type { JobFlow } from "./types.ts";

export const runReview: JobFlow = async (context) => {
  const { config, github, events, job, provider, signal } = context;
  const fullName = job.repository.fullName;
  if (!job.pullRequest) {
    throw new Error("REVIEW job has no managed pull request association");
  }
  if (!job.headSha) {
    throw new Error("REVIEW job has no target head SHA");
  }
  const pullRequest = job.pullRequest;

  const stale = async () => {
    const finished = await jobRepository.finishRunning(job.id, "COMPLETED", {
      result: `Stale review: the pull request head moved past ${job.headSha} before this review could apply.`,
    });
    if (!finished) return;
    await events.record({
      type: "STALE_RESULT_DISCARDED",
      message: `Discarded the review result for ${fullName}#${pullRequest.prNumber} because the pull request head moved past ${job.headSha}`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: { issueUrl: job.issueUrl, pullRequestUrl: job.pullRequestUrl ?? undefined, headSha: job.headSha },
    });
  };

  const initial = await github.getPullRequest(fullName, pullRequest.prNumber);
  context.state.activePullRequest = { number: initial.number, url: initial.url };
  if (initial.headSha !== job.headSha) {
    await stale();
    return;
  }

  context.state.liveContext = await github.getIssueContext(fullName, job.issueNumber, job.issueUrl, pullRequest.prNumber);
  const liveContext = context.state.liveContext;
  const diff = await github.getPullRequestDiff(fullName, pullRequest.prNumber);

  if (!job.repository.localPath) throw new Error("Repository has no synchronized local path");
  const localPath = job.repository.localPath;
  const gitEnvironment = githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl);
  const worktree = await prepareJobWorktree(job, safeWorktreePath(config.DATA_DIR, job.id), async () => {
    await context.createReviewWorktree({
      repositoryPath: localPath,
      worktreePath: safeWorktreePath(config.DATA_DIR, job.id),
      branchName: pullRequest.headBranch,
      gitEnvironment,
    });
  });
  const worktreePath = worktree.path;
  context.state.worktreeCreated = true;
  context.state.worktreePath = worktreePath;
  context.state.repositoryPath = localPath;
  context.state.worktreePersisted = !worktree.created;
  if (worktree.created) {
    if (!await jobRepository.setWorktree(job.id, worktreePath)) return;
    context.state.worktreePersisted = true;
  }

  await events.record({
    type: "JOB_STARTED",
    message: `Started REVIEW on ${fullName}#${pullRequest.prNumber} at ${job.headSha}`,
    jobId: job.id,
    repositoryId: job.repositoryId,
    scanRunId: job.scanRunId ?? undefined,
    metadata: {
      issueUrl: job.issueUrl,
      pullRequestUrl: job.pullRequestUrl ?? undefined,
      provider: provider.name,
      model: job.model,
      headSha: job.headSha,
    },
  });

  const reviewRow = await reviewRepository.start(
    job.id,
    job.provider,
    job.model,
    job.reasoningEffort,
    {
      pullRequestId: pullRequest.id,
      pullRequestNumber: pullRequest.prNumber,
      headSha: job.headSha,
    },
  );
  try {
    const result = await context.executeRoleWithRetry(
      "reviewer",
      `Independently review ${job.pullRequestUrl}`,
      reviewContext(job, liveContext, diff),
      (response) => { parseReviewOutcome(response); },
      worktreePath,
      signal,
      job,
    );
    if (result.exitCode !== 0) throw new Error(result.stderr || "Automated review failed");
    const verdict = parseReviewOutcome(result.response);
    const tldr = parseTldr(result.response);
    await reviewRepository.finish(
      reviewRow.id,
      verdict === "pass" ? "PASSED" : "CHANGES_REQUESTED",
      {
        sessionId: result.sessionId,
        response: result.response,
        exitCode: result.exitCode,
      },
    );
    await events.record({
      type: "REVIEW_COMPLETED",
      message: `Review ${verdict} for ${fullName}#${pullRequest.prNumber} at ${job.headSha}`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: {
        issueUrl: job.issueUrl,
        pullRequestUrl: job.pullRequestUrl ?? undefined,
        pullRequestNumber: pullRequest.prNumber,
        headSha: job.headSha,
        verdict,
        tldr,
      },
    });
    const current = await github.getPullRequest(fullName, pullRequest.prNumber);
    if (current.headSha !== job.headSha) {
      await stale();
      return;
    }
    await context.commentOnPullRequest(job, pullRequest.prNumber, result.response);

    if (verdict === "pass") {
      try {
        await applyPullRequestLabels(github, config, job, pullRequest.prNumber, [config.PR_REVIEW_PASSED_LABEL]);
        await managedPullRequestRepository.setWorkflow(job.repositoryId, pullRequest.prNumber, "REVIEW_PASSED");
        await managedPullRequestRepository.resetFixCycle(job.repositoryId, pullRequest.prNumber);
        await events.record({
          type: "REVIEW_PASSED",
          message: `Review passed for ${fullName}#${pullRequest.prNumber} at ${job.headSha}`,
          jobId: job.id,
          repositoryId: job.repositoryId,
          scanRunId: job.scanRunId ?? undefined,
          metadata: { issueUrl: job.issueUrl, pullRequestUrl: job.pullRequestUrl ?? undefined, headSha: job.headSha, tldr },
        });
      } catch (error) {
        await events.record({
          type: "GITHUB_RECONCILIATION_REQUIRED",
          level: "ERROR",
          message: `Could not apply the review-passed label to PR #${pullRequest.prNumber}: ${safeError(error)}`,
          jobId: job.id,
          repositoryId: job.repositoryId,
          scanRunId: job.scanRunId ?? undefined,
          metadata: { issueUrl: job.issueUrl, pullRequestUrl: job.pullRequestUrl },
        });
        throw error;
      }
      const finished = await jobRepository.finishRunning(job.id, "COMPLETED", {
        result: result.response,
        exitCode: result.exitCode,
        pullRequestNumber: pullRequest.prNumber,
        pullRequestUrl: job.pullRequestUrl ?? undefined,
        headSha: job.headSha,
      });
      if (!finished) return;
      await context.finalizeIssue(
        job,
        [config.ISSUE_READY_TO_MERGE_LABEL],
        `${result.response}\n\n## Automated review passed\n\nThe pull request #${pullRequest.prNumber} passed the automated review. Merge it manually when ready.`,
      );
      await events.record({
        type: "READY_TO_MERGE",
        message: `${fullName}#${job.issueNumber} is ready to merge; awaiting a human merge`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, pullRequestUrl: job.pullRequestUrl, tldr },
      });
      await events.record({
        type: "JOB_COMPLETED",
        message: `Completed REVIEW on ${fullName}#${pullRequest.prNumber} · passed`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: {
          issueUrl: job.issueUrl,
          pullRequestUrl: job.pullRequestUrl,
          tldr,
          headSha: job.headSha,
          verdict: "pass",
        },
      });
      return;
    }

    try {
      await applyPullRequestLabels(github, config, job, pullRequest.prNumber, [config.PR_FIX_REQUESTED_LABEL]);
      await managedPullRequestRepository.setWorkflow(
        job.repositoryId,
        pullRequest.prNumber,
        "FIX_REQUESTED",
        { fixReason: "REVIEW_CHANGES_REQUESTED", fixDetails: result.response },
      );
      await events.record({
        type: "PR_FIX_REQUESTED",
        message: `Review requested changes on ${fullName}#${pullRequest.prNumber}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: {
          issueUrl: job.issueUrl,
          pullRequestUrl: job.pullRequestUrl ?? undefined,
          headSha: job.headSha,
          fixReason: "REVIEW_CHANGES_REQUESTED",
          tldr,
        },
      });
    } catch (error) {
      await events.record({
        type: "GITHUB_RECONCILIATION_REQUIRED",
        level: "ERROR",
        message: `Could not apply the fix-requested label to PR #${pullRequest.prNumber}: ${safeError(error)}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, pullRequestUrl: job.pullRequestUrl },
      });
      throw error;
    }
    const finished = await jobRepository.finishRunning(job.id, "COMPLETED", {
      result: result.response,
      exitCode: result.exitCode,
      pullRequestNumber: pullRequest.prNumber,
      pullRequestUrl: job.pullRequestUrl ?? undefined,
      headSha: job.headSha,
    });
    if (!finished) return;
    await events.record({
      type: "JOB_COMPLETED",
      message: `Completed REVIEW on ${fullName}#${pullRequest.prNumber} · changes requested`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: {
        issueUrl: job.issueUrl,
        pullRequestUrl: job.pullRequestUrl ?? undefined,
        headSha: job.headSha,
        verdict: "changes_requested",
        tldr,
      },
    });
    return;
  } catch (error) {
    if (!isQuotaFailure(error)) {
      await reviewRepository.finish(reviewRow.id, "FAILED", { errorMessage: safeError(error) });
    }
    throw error;
  }
};

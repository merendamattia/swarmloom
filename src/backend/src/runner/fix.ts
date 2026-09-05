import { githubGitEnvironment } from "../github/git-auth.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { managedPullRequestRepository } from "../repositories/managed-prs.ts";
import { safeWorktreePath } from "./paths.ts";
import {
  applyPullRequestLabels,
  fixContext,
  parseJobOutcome,
  parseTldr,
  prepareJobWorktree,
  safeError,
} from "./helpers.ts";
import { isQuotaFailure } from "./diagnostics.ts";
import type { JobFlow } from "./types.ts";

export const runFix: JobFlow = async (context) => {
  const { config, github, events, job, provider, signal } = context;
  const fullName = job.repository.fullName;
  if (!job.pullRequest) {
    throw new Error("FIX job has no managed pull request association");
  }
  const pullRequest = job.pullRequest;
  context.state.liveContext = await github.getIssueContext(fullName, job.issueNumber, job.issueUrl, pullRequest.prNumber);
  const liveContext = context.state.liveContext;

  if (!job.repository.localPath) throw new Error("Repository has no synchronized local path");
  const localPath = job.repository.localPath;
  const worktree = await prepareJobWorktree(job, safeWorktreePath(config.DATA_DIR, job.id, job.attempts), async () => {
    await context.createReviewWorktree({
      repositoryPath: localPath,
      worktreePath: safeWorktreePath(config.DATA_DIR, job.id, job.attempts),
      branchName: pullRequest.headBranch,
      gitEnvironment: githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl),
    });
  });
  const worktreePath = worktree.path;
  context.state.worktreeCreated = true;
  context.state.worktreePath = worktreePath;
  context.state.repositoryPath = localPath;
  context.state.worktreePersisted = !worktree.created;
  if (worktree.created) {
    if (!await jobRepository.setWorktree(job.id, worktreePath, job.attempts)) return;
    context.state.worktreePersisted = true;
  }

  await events.record({
    type: "JOB_STARTED",
    message: `Started FIX on ${fullName}#${pullRequest.prNumber} for issue #${job.issueNumber} · ${job.issueTitle}`,
    jobId: job.id,
    repositoryId: job.repositoryId,
    scanRunId: job.scanRunId ?? undefined,
    metadata: {
      issueUrl: job.issueUrl,
      pullRequestUrl: job.pullRequestUrl,
      provider: provider.name,
      model: job.model,
      headSha: job.headSha,
      trigger: job.trigger,
    },
  });

  const reason = job.trigger ?? "PR_FIX_REQUESTED";
  let resultTldr: string | undefined;
  try {
    const result = await context.executeRoleWithRetry(
      "issue-worker",
      `Fix ${fullName}#${pullRequest.prNumber} for issue #${job.issueNumber}: ${job.issueTitle}`,
      fixContext(job, liveContext, reason, pullRequest.fixDetails),
      (response) => { parseJobOutcome(response); },
      worktreePath,
      signal,
      job,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `${provider.name} exited with ${result.exitCode}`);
    }
    await jobRepository.setExecutionResult(job.id, result.sessionId, result.exitCode, job.attempts);

    const blockedOutcome = parseJobOutcome(result.response) === "blocked";
    resultTldr = parseTldr(result.response);
    if (blockedOutcome) {
      await managedPullRequestRepository.block(job.repositoryId, pullRequest.prNumber);
      await applyPullRequestLabels(github, config, job, pullRequest.prNumber, [config.ISSUE_HUMAN_REVIEW_LABEL]);
      const finished = await jobRepository.finishRunning(job.id, "BLOCKED", {
        result: result.response,
        exitCode: result.exitCode,
      }, job.attempts);
      if (!finished) return;
      await events.record({
        type: "JOB_BLOCKED",
        message: `FIX blocked on ${fullName}#${pullRequest.prNumber}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, pullRequestUrl: job.pullRequestUrl, tldr: resultTldr },
      });
      await context.finalizeIssue(job, [config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL], result.response);
      await context.commentOnPullRequest(job, pullRequest.prNumber, result.response);
      return;
    }

    const current = await github.getPullRequest(fullName, pullRequest.prNumber);
    context.state.activePullRequest = { number: current.number, url: current.url };
    if (current.headSha === job.headSha) {
      throw new Error(`FIX completed but PR #${current.number} still points at ${current.headSha}; the branch push was not detected`);
    }
    await managedPullRequestRepository.updateHead(job.repositoryId, pullRequest.prNumber, current.head, current.headSha);
    const fixCycleCount = await managedPullRequestRepository.incrementFixCycle(job.repositoryId, pullRequest.prNumber);
    const loopExceeded = fixCycleCount !== null && fixCycleCount >= config.MAX_AUTOMATIC_FIX_CYCLES;

    if (loopExceeded) {
      await blockWorkflow(result.response, resultTldr, current.number, current.url, current.headSha, fixCycleCount);
      return;
    }

    await managedPullRequestRepository.setWorkflow(job.repositoryId, pullRequest.prNumber, "REVIEW_REQUESTED", {
      fixReason: null,
      fixDetails: null,
    });
    try {
      await applyPullRequestLabels(github, config, job, pullRequest.prNumber, [config.PR_REVIEW_REQUESTED_LABEL]);
      await events.record({
        type: "PR_REVIEW_REQUESTED",
        message: `PR #${pullRequest.prNumber} returned to review-requested after a fix`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, pullRequestUrl: current.url, headSha: current.headSha, tldr: resultTldr },
      });
    } catch (error) {
      await events.record({
        type: "GITHUB_RECONCILIATION_REQUIRED",
        level: "ERROR",
        message: `Could not re-apply the review-requested label to PR #${pullRequest.prNumber}: ${safeError(error)}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, pullRequestUrl: current.url },
      });
    }
    const finished = await jobRepository.finishRunning(job.id, "COMPLETED", {
      result: result.response,
      exitCode: result.exitCode,
      pullRequestNumber: current.number,
      pullRequestUrl: current.url,
      headSha: current.headSha,
    }, job.attempts);
    if (!finished) return;
    await events.record({
      type: "JOB_COMPLETED",
      message: `Completed FIX on ${fullName}#${pullRequest.prNumber} · ${reason}`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: {
        issueUrl: job.issueUrl,
        pullRequestUrl: current.url,
        pullRequestNumber: current.number,
        headSha: current.headSha,
        trigger: reason,
        provider: provider.name,
        model: job.model,
        tldr: resultTldr,
      },
    });
    await context.commentOnPullRequest(job, pullRequest.prNumber, result.response);
  } catch (error) {
    if (!isQuotaFailure(error)) await guardFailure(error);
    throw error;
  }

  async function guardFailure(error: unknown) {
    const fixCycleCount = await managedPullRequestRepository.incrementFixCycle(job.repositoryId, pullRequest.prNumber);
    if (fixCycleCount === null || fixCycleCount < config.MAX_AUTOMATIC_FIX_CYCLES) return;
    await managedPullRequestRepository.block(job.repositoryId, pullRequest.prNumber);
    try {
      await applyPullRequestLabels(github, config, job, pullRequest.prNumber, [config.ISSUE_HUMAN_REVIEW_LABEL]);
    } catch (labelError) {
      await events.record({
        type: "GITHUB_RECONCILIATION_REQUIRED",
        level: "ERROR",
        message: `Could not apply the human-review label to PR #${pullRequest.prNumber}: ${safeError(labelError)}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, pullRequestUrl: job.pullRequestUrl },
      });
    }
    await events.record({
      type: "LOOP_GUARD_TRIPPED",
      level: "ERROR",
      message: `Automatic fix limit (${config.MAX_AUTOMATIC_FIX_CYCLES}) reached for PR #${pullRequest.prNumber}; the workflow is blocked and requires human review`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: { issueUrl: job.issueUrl, pullRequestUrl: job.pullRequestUrl, fixCycleCount, tldr: resultTldr },
    });
    await context.finalizeIssue(
      job,
      [config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL],
      `Automatic fix cycles exceeded the limit of ${config.MAX_AUTOMATIC_FIX_CYCLES}. The workflow is blocked for human review.\n\nLast failure: ${safeError(error)}`,
    );
    await context.commentOnPullRequest(
      job,
      pullRequest.prNumber,
      `## Swarmloom loop guard\n\nThis pull request reached the automatic fix limit of ${config.MAX_AUTOMATIC_FIX_CYCLES} cycles. Automation is stopped until a human reviews it.\n\nLast failure:\n\n${safeError(error)}`,
    );
  }

  async function blockWorkflow(
    response: string,
    tldr: string,
    prNumber: number,
    pullRequestUrl: string | undefined,
    headSha: string | undefined,
    fixCycleCount: number,
  ) {
    await managedPullRequestRepository.block(job.repositoryId, pullRequest.prNumber);
    try {
      await applyPullRequestLabels(github, config, job, pullRequest.prNumber, [config.ISSUE_HUMAN_REVIEW_LABEL]);
    } catch (error) {
      await events.record({
        type: "GITHUB_RECONCILIATION_REQUIRED",
        level: "ERROR",
        message: `Could not apply the human-review label to PR #${pullRequest.prNumber}: ${safeError(error)}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, pullRequestUrl: job.pullRequestUrl },
      });
    }
    const finished = await jobRepository.finishRunning(job.id, "COMPLETED", {
      result: response,
      pullRequestNumber: prNumber,
      pullRequestUrl: pullRequestUrl,
      headSha,
    }, job.attempts);
    if (!finished) return;
    await events.record({
      type: "LOOP_GUARD_TRIPPED",
      level: "ERROR",
      message: `Automatic fix limit (${config.MAX_AUTOMATIC_FIX_CYCLES}) reached for PR #${pullRequest.prNumber}; the workflow is blocked and requires human review`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: { issueUrl: job.issueUrl, pullRequestUrl: job.pullRequestUrl, fixCycleCount, tldr },
    });
    await context.finalizeIssue(
      job,
      [config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL],
      `${response}\n\nAutomatic fix cycles exceeded the limit of ${config.MAX_AUTOMATIC_FIX_CYCLES}. The workflow is blocked for human review.`,
    );
    await context.commentOnPullRequest(
      job,
      pullRequest.prNumber,
      `${response}\n\n## Swarmloom loop guard\n\nThis pull request reached the automatic fix limit of ${config.MAX_AUTOMATIC_FIX_CYCLES} cycles. Automation is stopped until a human reviews it.`,
    );
  }
};

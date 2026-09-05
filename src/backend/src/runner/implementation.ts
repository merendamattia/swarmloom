import { githubGitEnvironment } from "../github/git-auth.ts";
import { managedPullRequestRepository } from "../repositories/managed-prs.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { safeWorktreePath } from "./paths.ts";
import {
  applyPullRequestLabels,
  implementationContext,
  parseJobOutcome,
  parsePullRequestUrl,
  parseTldr,
  prepareJobWorktree,
  safeError,
} from "./helpers.ts";
import type { JobFlow } from "./types.ts";

export const runImplementation: JobFlow = async (context) => {
  const { config, github, events, queue, job, provider, signal } = context;
  const fullName = job.repository.fullName;
  context.state.liveContext = await github.getIssueContext(fullName, job.issueNumber, job.issueUrl);
  const liveContext = context.state.liveContext;

  if (!job.repository.localPath) throw new Error("Repository has no synchronized local path");
  const localPath = job.repository.localPath;
  const worktree = await prepareJobWorktree(job, safeWorktreePath(config.DATA_DIR, job.id, job.attempts), async () => {
    await context.createWorktree({
      repositoryPath: localPath,
      worktreePath: safeWorktreePath(config.DATA_DIR, job.id, job.attempts),
      branchName: job.branchName,
      baselineCommit: job.baselineCommit,
      gitEnvironment: githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl),
    });
  });
  const worktreePath = worktree.path;
  context.state.worktreeCreated = true;
  context.state.worktreePath = worktreePath;
  context.state.repositoryPath = localPath;
  context.state.worktreePersisted = !worktree.created;
  if (worktree.created) {
    if (!await jobRepository.setWorktree(job.id, job.claimToken, worktreePath)) return;
    context.state.worktreePersisted = true;
  }

  await events.record({
    type: "JOB_STARTED",
    message: `Started ${job.repository.fullName}#${job.issueNumber} · ${job.issueTitle}`,
    jobId: job.id,
    repositoryId: job.repositoryId,
    scanRunId: job.scanRunId ?? undefined,
    metadata: { issueUrl: job.issueUrl, provider: provider.name, model: job.model },
  });

  const implementation = await context.executeRoleWithRetry(
    "issue-worker",
    `Process ${fullName}#${job.issueNumber}: ${job.issueTitle}`,
    implementationContext(job, liveContext),
    (response) => { parseJobOutcome(response); },
    worktreePath,
    signal,
    job,
  );
  if (!await jobRepository.setExecutionResult(job.id, job.claimToken, implementation.sessionId, implementation.exitCode)) return;
  if (implementation.exitCode !== 0) {
    throw new Error(implementation.stderr || `${provider.name} exited with ${implementation.exitCode}`);
  }
  const outcome = parseJobOutcome(implementation.response);
  const tldr = parseTldr(implementation.response);

  if (outcome === "implemented") {
    const pullRequestUrl = parsePullRequestUrl(implementation.response);
    if (!pullRequestUrl) {
      throw new Error('Implemented agent response must include a "PR: <url>" line');
    }
    const pullRequestNumber = Number(/\/pull\/(\d+)/.exec(pullRequestUrl)?.[1]);
    const pullRequest = await github.getPullRequest(fullName, pullRequestNumber);
    context.state.activePullRequest = { number: pullRequest.number, url: pullRequest.url };
    if (pullRequest.base !== "develop" || pullRequest.head !== job.branchName) {
      throw new Error(`PR #${pullRequest.number} must use ${job.branchName} -> develop`);
    }
    const issueReference = `Closes #${job.issueNumber}`;
    if (!pullRequest.body.includes(issueReference) || pullRequest.body.includes("[REDACTED]")) {
      throw new Error(`PR #${pullRequest.number} must contain ${issueReference} and no [REDACTED] markers`);
    }
    if (!await jobRepository.isActiveClaim(job.id, job.workerId, job.claimToken)) return;
    const managedPullRequestId = await managedPullRequestRepository.upsertFromImplementation({
      repositoryId: job.repositoryId,
      prNumber: pullRequest.number,
      issueNumber: job.issueNumber,
      issueTitle: job.issueTitle,
      issueUrl: job.issueUrl,
      headBranch: pullRequest.head,
      headSha: pullRequest.headSha,
      baseBranch: pullRequest.base,
      implementationJobId: job.id,
    });
    if (!managedPullRequestId) {
      throw new Error(`Could not persist managed pull request ${fullName}#${pullRequest.number}`);
    }
    if (!await jobRepository.isActiveClaim(job.id, job.workerId, job.claimToken)) return;
    const finished = await jobRepository.finishRunning(job.id, job.claimToken, "COMPLETED", {
      result: implementation.response,
      exitCode: implementation.exitCode,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      headSha: pullRequest.headSha,
    });
    if (!finished) return;
    await events.record({
      type: "PR_OPENED",
      message: `Opened PR #${pullRequest.number} for ${fullName}#${job.issueNumber}`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: {
        issueUrl: job.issueUrl,
        pullRequestUrl: pullRequest.url,
        pullRequestNumber: pullRequest.number,
        pullRequestTitle: pullRequest.title,
        pullRequestBody: pullRequest.body,
        tldr,
        filesChanged: pullRequest.changedFiles,
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        headSha: pullRequest.headSha,
      },
    });
    try {
      await applyPullRequestLabels(github, config, job, pullRequest.number, [config.PR_REVIEW_REQUESTED_LABEL]);
      await managedPullRequestRepository.setWorkflow(job.repositoryId, pullRequest.number, "REVIEW_REQUESTED");
      await events.record({
        type: "PR_REVIEW_REQUESTED",
        message: `PR #${pullRequest.number} now requires automated review`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, pullRequestUrl: pullRequest.url, headSha: pullRequest.headSha, tldr },
      });
    } catch (error) {
      await events.record({
        type: "GITHUB_RECONCILIATION_REQUIRED",
        level: "ERROR",
        message: `Could not apply the review-requested label to PR #${pullRequest.number}: ${safeError(error)}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, pullRequestUrl: pullRequest.url },
      });
    }
    await events.record({
      type: "JOB_COMPLETED",
      message: `Completed ${fullName}#${job.issueNumber} with PR #${pullRequest.number} using ${provider.name}/${job.model}`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: {
        issueUrl: job.issueUrl,
        pullRequestUrl: pullRequest.url,
        pullRequestNumber: pullRequest.number,
        provider: provider.name,
        model: job.model,
        tldr,
      },
    });
    await context.finalizeIssue(job, [config.ISSUE_WORKING_LABEL], implementation.response);
    return;
  }

  if (outcome === "requires_decomposition") {
    const finished = await jobRepository.finishRunning(job.id, job.claimToken, "COMPLETED", {
      result: implementation.response,
      exitCode: implementation.exitCode,
    });
    if (!finished) return;
    // DECOMPOSITION deliberately inherits the coding profile snapshot from its implementation job.
    const decomposition = await jobRepository.tryCreateQueued({
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      environment: job.environment,
      jobType: "DECOMPOSITION",
      subjectType: "ISSUE",
      issueNumber: job.issueNumber,
      issueTitle: job.issueTitle,
      issueUrl: job.issueUrl,
      issueBody: job.issueBody,
      branchName: `agent/decompose-${job.issueNumber}-${crypto.randomUUID().slice(0, 8)}`,
      baselineCommit: job.baselineCommit,
      provider: job.provider,
      model: job.model,
      reasoningEffort: job.reasoningEffort ?? undefined,
    });
    if (decomposition) {
      await queue.enqueue(decomposition.id);
      await events.record({
        type: "JOB_QUEUED",
        message: `Queued decomposition for ${fullName}#${job.issueNumber}`,
        jobId: decomposition.id,
        repositoryId: job.repositoryId,
        scanRunId: decomposition.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, issueNumber: job.issueNumber },
      });
    }
    await events.record({
      type: "JOB_COMPLETED",
      message: `Completed ${fullName}#${job.issueNumber} with a decomposition request using ${provider.name}/${job.model}`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: { issueUrl: job.issueUrl, tldr },
    });
    await context.finalizeIssue(job, [config.ISSUE_WORKING_LABEL], implementation.response);
    return;
  }

  if (outcome === "blocked") {
    const finished = await jobRepository.finishRunning(job.id, job.claimToken, "BLOCKED", {
      result: implementation.response,
      exitCode: implementation.exitCode,
    });
    if (!finished) return;
    await events.record({ type: "JOB_BLOCKED", message: "Worker blocked", jobId: job.id, repositoryId: job.repositoryId, scanRunId: job.scanRunId ?? undefined, metadata: { issueUrl: job.issueUrl, tldr } });
    await context.finalizeIssue(job, [config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL], implementation.response);
    return;
  }
};

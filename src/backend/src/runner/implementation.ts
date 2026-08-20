import { githubGitEnvironment } from "../github/git-auth.ts";
import { managedPullRequestRepository } from "../repositories/managed-prs.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { safeWorktreePath } from "./paths.ts";
import {
  applyPullRequestLabels,
  duration,
  implementationContext,
  parseJobOutcome,
  parsePullRequestUrl,
  safeError,
} from "./helpers.ts";
import { parseFrontendVisualRequest } from "./response.ts";
import { visualEvidenceComment, visualEvidenceMarker } from "./visual-comment.ts";
import type { JobFlow } from "./types.ts";

export const runImplementation: JobFlow = async (context) => {
  const { config, github, events, queue, job, provider, signal } = context;
  const fullName = job.repository.fullName;
  context.state.liveContext = await github.getIssueContext(fullName, job.issueNumber, job.issueUrl);
  const liveContext = context.state.liveContext;

  if (!job.repository.localPath) throw new Error("Repository has no synchronized local path");
  const localPath = job.repository.localPath;
  const worktreePath = safeWorktreePath(config.DATA_DIR, job.id);
  const gitEnvironment = githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl);
  await context.createWorktree({
    repositoryPath: localPath,
    worktreePath,
    branchName: job.branchName,
    baselineCommit: job.baselineCommit,
    gitEnvironment,
  });
  context.state.worktreeCreated = true;
  context.state.worktreePath = worktreePath;
  context.state.repositoryPath = localPath;
  if (!await jobRepository.setWorktree(job.id, worktreePath)) return;

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
  await jobRepository.setImplementationResult(job.id, implementation.sessionId, implementation.exitCode);
  if (implementation.exitCode !== 0) {
    throw new Error(implementation.stderr || `${provider.name} exited with ${implementation.exitCode}`);
  }
  const outcome = parseJobOutcome(implementation.response);

  if (outcome === "implemented") {
    const visualRequest = parseFrontendVisualRequest(implementation.response);
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
    if (!pullRequest.body.includes(`#${job.issueNumber}`)
      && !pullRequest.body.includes(job.issueUrl)) {
      throw new Error(`PR #${pullRequest.number} is not linked to issue #${job.issueNumber}`);
    }
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
    const visualVerification = await completeVisualVerification(context, visualRequest, job.id, worktreePath, managedPullRequestId, pullRequest.url, pullRequest.number, signal);
    const finished = await jobRepository.finishRunning(job.id, "COMPLETED", {
      result: implementation.response,
      visualVerification,
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
        metadata: { issueUrl: job.issueUrl, pullRequestUrl: pullRequest.url, headSha: pullRequest.headSha },
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
      message: `Completed ${fullName}#${job.issueNumber} with PR #${pullRequest.number} using ${provider.name}/${job.model} in ${duration(job.startedAt)}`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: {
        issueUrl: job.issueUrl,
        pullRequestUrl: pullRequest.url,
        pullRequestNumber: pullRequest.number,
        provider: provider.name,
        model: job.model,
      },
    });
    await context.finalizeIssue(job, [config.ISSUE_WORKING_LABEL], implementation.response);
    return;
  }

  if (outcome === "requires_decomposition") {
    const finished = await jobRepository.finishRunning(job.id, "COMPLETED", {
      result: implementation.response,
      exitCode: implementation.exitCode,
    });
    if (!finished) return;
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
      metadata: { issueUrl: job.issueUrl },
    });
    await context.finalizeIssue(job, [config.ISSUE_WORKING_LABEL], implementation.response);
    return;
  }

  if (outcome === "blocked") {
    const finished = await jobRepository.finishRunning(job.id, "BLOCKED", {
      result: implementation.response,
      exitCode: implementation.exitCode,
    });
    if (!finished) return;
    await events.record({ type: "JOB_BLOCKED", message: "Worker blocked", jobId: job.id, repositoryId: job.repositoryId, scanRunId: job.scanRunId ?? undefined, metadata: { issueUrl: job.issueUrl } });
    await context.finalizeIssue(job, [config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL], implementation.response);
    return;
  }
};

type VisualVerificationRecord =
  | import("./visual-verification.ts").VisualVerificationResult
  | { status: "NOT_REQUIRED"; reason: string; capturedAt: string };

async function completeVisualVerification(
  context: import("./types.ts").RunnerContext,
  request: import("./response.ts").FrontendVisualRequest,
  jobId: string,
  worktreePath: string,
  managedPullRequestId: string,
  pullRequestUrl: string,
  pullRequestNumber: number,
  signal: AbortSignal,
): Promise<VisualVerificationRecord> {
  const capturedAt = new Date().toISOString();
  if (!request.frontendChanged) {
    return { status: "NOT_REQUIRED", reason: "Agent declared that the implementation does not change the frontend", capturedAt };
  }
  if (!request.route) {
    const incomplete = {
      status: "INCOMPLETE" as const,
      route: null,
      reason: "Frontend change was declared without a valid Visual route marker",
      capturedAt,
    };
    await recordVisualIncomplete(context, jobId, incomplete);
    return incomplete;
  }

  let result: import("./visual-verification.ts").VisualVerificationResult;
  try {
    result = await context.visualVerification.verify({
      jobId,
      worktreePath,
      route: request.route,
      origin: request.origin!,
      setup: request.setup,
      signal,
    });
  } catch (error) {
    result = {
      status: "INCOMPLETE",
      route: request.route,
      reason: safeError(error),
      capturedAt,
    };
  }

  if (result.status === "COMPLETED") {
    const visualEvidenceKey = `swarmloom:visual-evidence:${managedPullRequestId}`;
    const claim = await managedPullRequestRepository.claimVisualEvidence(managedPullRequestId, visualEvidenceKey, result);
    if (!claim) {
      result = {
        status: "INCOMPLETE",
        route: result.route,
        reason: "Could not claim durable visual evidence state for the managed pull request",
        capturedAt: result.capturedAt,
      };
      return persistVisualIncomplete(context, jobId, result);
    }
    const claimedResult = claim.result as Extract<import("./visual-verification.ts").VisualVerificationResult, { status: "COMPLETED" }>;
    if (!await jobRepository.setVisualVerification(jobId, claimedResult)) return claimedResult;
    if (!claim.publishedAt) {
      let alreadyPublished = false;
      try {
        const liveContext = await context.github.getIssueContext(context.job.repository.fullName, pullRequestNumber, pullRequestUrl);
        alreadyPublished = liveContext.issueComments.some((comment) => comment.body.includes(visualEvidenceMarker(claim.key)));
      } catch (error) {
        result = {
          status: "INCOMPLETE",
          route: claimedResult.route,
          reason: "Could not inspect pull request comments for existing visual evidence: " + safeError(error),
          capturedAt: claimedResult.capturedAt,
        };
        return persistVisualIncomplete(context, jobId, result);
      }
      if (!alreadyPublished) {
        const published = await context.commentOnPullRequest(
          context.job,
          pullRequestNumber,
          visualEvidenceComment(claimedResult, claim.key),
        );
        if (!published) {
          result = {
            status: "INCOMPLETE",
            route: claimedResult.route,
            reason: "Screenshot was captured but the visual-evidence pull request comment could not be published",
            capturedAt: claimedResult.capturedAt,
          };
          return persistVisualIncomplete(context, jobId, result);
        }
      }
      await managedPullRequestRepository.markVisualEvidencePublished(managedPullRequestId, claim.key);
    }
    await context.events.record({
      type: "VISUAL_VERIFICATION_COMPLETED",
      message: "Captured visual evidence for " + claimedResult.route + " on PR #" + pullRequestNumber,
      jobId,
      repositoryId: context.job.repositoryId,
      scanRunId: context.job.scanRunId ?? undefined,
      metadata: { route: claimedResult.route, artifactUrl: claimedResult.artifactUrl, viewport: claimedResult.viewport },
    });
    return claimedResult;
  }

  await recordVisualIncomplete(context, jobId, result);
  return result;
}

async function persistVisualIncomplete(
  context: import("./types.ts").RunnerContext,
  jobId: string,
  result: Extract<VisualVerificationRecord, { status: "INCOMPLETE" }>,
) {
  await jobRepository.setVisualVerification(jobId, result);
  await recordVisualIncomplete(context, jobId, result);
  return result;
}

async function recordVisualIncomplete(
  context: import("./types.ts").RunnerContext,
  jobId: string,
  result: Extract<VisualVerificationRecord, { status: "INCOMPLETE" }>,
) {
  await context.events.record({
    type: "VISUAL_VERIFICATION_INCOMPLETE",
    level: "WARNING",
    message: "Visual verification incomplete: " + result.reason,
    jobId,
    repositoryId: context.job.repositoryId,
    scanRunId: context.job.scanRunId ?? undefined,
    metadata: { route: result.route, reason: result.reason },
  });
}

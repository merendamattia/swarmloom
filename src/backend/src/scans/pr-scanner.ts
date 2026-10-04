import type { ManagedPullRequest, Repository } from "@prisma/client";
import { managedPullRequestRepository } from "../repositories/managed-prs.ts";
import { replaceWorkerLabels } from "../github/labels.ts";
import { agentProfileForJobType, configuredAgent } from "../providers/index.ts";
import { queueJob, safeError, transitionPullRequestLabels, type ScannerShared } from "./common.ts";
import { promoteDevelop } from "./promotion.ts";

export type PullRequestScannerDependencies = ScannerShared;

export function createPullRequestScanner(shared: ScannerShared) {
  const { config, github, events } = shared;

  async function run(repository: Repository, fullName: string, scanRunId: string) {
    const queued: Array<{ jobId: string; info: Parameters<typeof events.notifyQueuedSummary>[1][number] }> = [];
    const managedPullRequests = await discoverManagedPullRequests(repository, fullName, scanRunId);
    for (const managed of managedPullRequests) {
      try {
        const results = await reconcile(repository, fullName, scanRunId, managed);
        queued.push(...results);
      } catch (error) {
        await events.record({
          type: "PULL_REQUEST_RECONCILIATION_FAILED",
          level: "ERROR",
          message: `Could not reconcile ${fullName}#${managed.prNumber}: ${safeError(error)}`,
          repositoryId: repository.id,
          scanRunId,
          metadata: { issueUrl: managed.issueUrl, pullRequestNumber: managed.prNumber },
        });
      }
    }
    try {
      await promoteDevelop(fullName, {
        github,
        managedIssue: async (prNumber) =>
          (await managedPullRequestRepository.findByRepositoryAndNumber(repository.id, prNumber))?.issueNumber ?? null,
        withLock: (action) => managedPullRequestRepository.withPromotionLock(repository.id, action),
        warn: async (message) => {
          await events.record({ type: "GITHUB_RECONCILIATION_REQUIRED", level: "WARNING", message, repositoryId: repository.id, scanRunId });
        },
      });
    } catch (error) {
      await events.record({
        type: "GITHUB_RECONCILIATION_REQUIRED",
        level: "ERROR",
        message: `Could not reconcile develop promotion for ${fullName}: ${safeError(error)}`,
        repositoryId: repository.id,
        scanRunId,
      });
    }
    return queued;
  }

  async function discoverManagedPullRequests(repository: Repository, fullName: string, scanRunId: string) {
    const managed = new Map(
      (await managedPullRequestRepository.findOpen(repository.id)).map((pullRequest) => [pullRequest.prNumber, pullRequest]),
    );
    const labels = [
      config.PR_REVIEW_REQUESTED_LABEL,
      config.PR_FIX_REQUESTED_LABEL,
      config.PR_REVIEW_PASSED_LABEL,
    ];
    const candidates = new Map<number, Awaited<ReturnType<typeof github.listPullRequests>>[number]>();
    for (const label of labels) {
      for (const pullRequest of await github.listPullRequests(fullName, label)) {
        candidates.set(pullRequest.number, pullRequest);
      }
    }
    for (const candidate of candidates.values()) {
      if (managed.has(candidate.number)) continue;
      try {
        const pullRequest = await github.getPullRequest(fullName, candidate.number);
        if (pullRequest.state !== "open" || pullRequest.base !== "develop") continue;
        const issueNumber = originatingIssueNumber(pullRequest.head);
        if (issueNumber === null) {
          await events.record({
            type: "PULL_REQUEST_RECONCILIATION_REQUIRED",
            level: "WARNING",
            message: `Could not associate ${fullName}#${candidate.number} with an originating issue branch`,
            repositoryId: repository.id,
            scanRunId,
            metadata: { pullRequestNumber: candidate.number, pullRequestUrl: pullRequest.url },
          });
          continue;
        }
        const issue = await github.getIssue(fullName, issueNumber);
        await managedPullRequestRepository.upsertFromImplementation({
          repositoryId: repository.id,
          prNumber: pullRequest.number,
          issueNumber,
          issueTitle: issue.title,
          issueUrl: issue.url,
          headBranch: pullRequest.head,
          headSha: pullRequest.headSha,
          baseBranch: pullRequest.base,
        });
        await managedPullRequestRepository.setWorkflow(
          repository.id,
          pullRequest.number,
          candidate.labels.includes(config.PR_FIX_REQUESTED_LABEL)
            ? "FIX_REQUESTED"
            : candidate.labels.includes(config.PR_REVIEW_PASSED_LABEL)
              ? "REVIEW_PASSED"
              : "REVIEW_REQUESTED",
        );
        const imported = await managedPullRequestRepository.findByRepositoryAndNumber(repository.id, pullRequest.number);
        if (imported) managed.set(imported.prNumber, imported);
      } catch (error) {
        await events.record({
          type: "PULL_REQUEST_RECONCILIATION_FAILED",
          level: "ERROR",
          message: `Could not import ${fullName}#${candidate.number}: ${safeError(error)}`,
          repositoryId: repository.id,
          scanRunId,
            metadata: { pullRequestNumber: candidate.number, pullRequestUrl: `https://github.com/${fullName}/pull/${candidate.number}` },
        });
      }
    }
    return [...managed.values()];
  }

  async function reconcile(
    repository: Repository,
    fullName: string,
    scanRunId: string,
    managed: ManagedPullRequest,
  ) {
    const [pullRequest, labels] = await Promise.all([
      github.getPullRequest(fullName, managed.prNumber),
      github.getPullRequestLabels(fullName, managed.prNumber),
    ]);

    if (pullRequest.state === "closed" && pullRequest.merged) {
      await managedPullRequestRepository.markState(repository.id, managed.prNumber, "MERGED");
      await events.record({
        type: "PR_MERGED",
        message: `Pull request ${fullName}#${managed.prNumber} was merged`,
        repositoryId: repository.id,
        scanRunId,
        metadata: {
          issueUrl: managed.issueUrl,
          pullRequestNumber: managed.prNumber,
          pullRequestUrl: pullRequest.url,
          headSha: managed.headSha,
        },
      });
      try {
        const issue = await github.getIssue(fullName, managed.issueNumber);
        await github.setIssueLabels(
          fullName,
          managed.issueNumber,
          replaceWorkerLabels(issue.labels, config, [config.ISSUE_COMPLETED_LABEL]),
        );
        await events.record({
          type: "ISSUE_DONE",
          message: `${fullName}#${managed.issueNumber} is done after the human merge of PR #${managed.prNumber}`,
          repositoryId: repository.id,
          scanRunId,
          metadata: { issueUrl: managed.issueUrl, pullRequestNumber: managed.prNumber },
        });
      } catch (error) {
        await events.record({
          type: "GITHUB_RECONCILIATION_REQUIRED",
          level: "ERROR",
          message: `Could not finalize issue ${fullName}#${managed.issueNumber} after the merge: ${safeError(error)}`,
          repositoryId: repository.id,
          scanRunId,
          metadata: { issueUrl: managed.issueUrl, pullRequestNumber: managed.prNumber },
        });
      }
      return [];
    }

    if (pullRequest.state === "closed") {
      await managedPullRequestRepository.markState(repository.id, managed.prNumber, "CLOSED");
      await events.record({
        type: "PULL_REQUEST_CLOSED",
        message: `Pull request ${fullName}#${managed.prNumber} was closed without merging`,
        repositoryId: repository.id,
        scanRunId,
        metadata: {
          issueUrl: managed.issueUrl,
          pullRequestNumber: managed.prNumber,
          pullRequestUrl: pullRequest.url,
        },
      });
      return [];
    }

    if (pullRequest.headSha !== managed.headSha || pullRequest.head !== managed.headBranch) {
      await managedPullRequestRepository.updateHead(repository.id, managed.prNumber, pullRequest.head, pullRequest.headSha);
    }

    const hasFixRequested = labels.includes(config.PR_FIX_REQUESTED_LABEL);
    const hasReviewRequested = labels.includes(config.PR_REVIEW_REQUESTED_LABEL);
    const hasReviewPassed = labels.includes(config.PR_REVIEW_PASSED_LABEL);

    if (hasFixRequested) {
      if (managed.blocked) {
        await managedPullRequestRepository.unblock(repository.id, managed.prNumber);
        await events.record({
          type: "PULL_REQUEST_UNBLOCKED",
          message: `Human re-enabled automation on ${fullName}#${managed.prNumber}`,
          repositoryId: repository.id,
          scanRunId,
          metadata: { issueUrl: managed.issueUrl, pullRequestNumber: managed.prNumber },
        });
      }
      return queuePrJob(repository, fullName, scanRunId, managed, pullRequest.headSha, "FIX", managed.fixReason ?? "PR_FIX_REQUESTED");
    }

    if (hasReviewPassed) {
      // automation succeeded; wait for the human merge
      return [];
    }

    if (hasReviewRequested) {
      return queuePrJob(repository, fullName, scanRunId, managed, pullRequest.headSha, "REVIEW", "PR_REVIEW_REQUESTED");
    }

    if (managed.workflow === "NONE" && managed.implementationJobId) {
      try {
        await transitionPullRequestLabels(shared, fullName, managed.prNumber, [config.PR_REVIEW_REQUESTED_LABEL]);
        await managedPullRequestRepository.setWorkflow(repository.id, managed.prNumber, "REVIEW_REQUESTED");
        await events.record({
          type: "PR_REVIEW_REQUESTED",
          message: `Restored review-requested on ${fullName}#${managed.prNumber}`,
          repositoryId: repository.id,
          scanRunId,
          metadata: {
            issueUrl: managed.issueUrl,
            pullRequestNumber: managed.prNumber,
            pullRequestUrl: pullRequest.url,
            headSha: pullRequest.headSha,
          },
        });
      } catch (error) {
        await events.record({
          type: "GITHUB_RECONCILIATION_REQUIRED",
          level: "ERROR",
          message: `Could not restore review-requested on ${fullName}#${managed.prNumber}: ${safeError(error)}`,
          repositoryId: repository.id,
          scanRunId,
          metadata: { issueUrl: managed.issueUrl, pullRequestNumber: managed.prNumber },
        });
        return [];
      }
      return queuePrJob(repository, fullName, scanRunId, managed, pullRequest.headSha, "REVIEW");
    }

    // no workflow label: a fresh PR not yet observed by implementation, or a human-controlled state
    return [];
  }

  async function queuePrJob(
    repository: Repository,
    fullName: string,
    scanRunId: string,
    managed: ManagedPullRequest,
    headSha: string,
    jobType: "FIX" | "REVIEW",
    trigger?: string,
  ) {
    const agent = configuredAgent(config, agentProfileForJobType(jobType));
    const pullRequestUrl = `https://github.com/${fullName}/pull/${managed.prNumber}`;
    const queuedJob = await queueJob(shared, fullName, {
      repositoryId: repository.id,
      environment: config.APP_ENV,
      jobType,
      subjectType: "PULL_REQUEST",
      issueNumber: managed.issueNumber,
      issueTitle: managed.issueTitle,
      issueUrl: managed.issueUrl,
      issueBody: "",
      branchName: managed.headBranch,
      baselineCommit: repository.baselineCommit ?? "",
      pullRequestId: managed.id,
      pullRequestNumber: managed.prNumber,
      pullRequestUrl,
      headSha,
      trigger,
      provider: agent.provider,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
    }, scanRunId);
    if (!queuedJob) return [];
    await events.record({
      type: "JOB_QUEUED",
      message: `Queued ${jobType} for ${fullName}#${managed.prNumber} at ${headSha}`,
      jobId: queuedJob.jobId,
      repositoryId: repository.id,
      scanRunId,
      metadata: {
        issueUrl: managed.issueUrl,
        pullRequestNumber: managed.prNumber,
        pullRequestUrl,
        headSha,
        trigger,
      },
    });
    return [queuedJob];
  }

  return { run };
}

function originatingIssueNumber(headBranch: string) {
  const match = /^agent\/issue-(\d+)(?:-|$)/.exec(headBranch);
  return match ? Number(match[1]) : null;
}

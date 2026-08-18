import type { EventService } from "../events/service.ts";
import type { GitHubClient, ParentIssue } from "../github/client.ts";
import type { JobQueue } from "../queue/service.ts";
import { jobRepository } from "../repositories/jobs.ts";

export function isParentResolved(parent: ParentIssue) {
  return parent.state === "closed" && parent.stateReason === "completed";
}

export function createDependencyGuard(
  github: Pick<GitHubClient, "getParentIssue">,
  events: EventService,
  queue: Pick<JobQueue, "remove">,
) {
  return async function dependencyGuard(payload: { jobId: string }) {
    const job = await jobRepository.findQueued(payload.jobId);
    if (!job) return true;
    let parent: ParentIssue | null;
    try {
      parent = await github.getParentIssue(job.repository.fullName, job.issueNumber);
    } catch {
      return true;
    }
    if (!parent || isParentResolved(parent)) return true;
    const result = await jobRepository.deferForDependency({
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId,
      environment: job.environment,
      issueNumber: job.issueNumber,
      issueTitle: job.issueTitle,
      issueUrl: job.issueUrl,
      issueBody: job.issueBody,
      branchName: job.branchName,
      baselineCommit: job.baselineCommit,
      provider: job.provider,
      model: job.model,
      reasoningEffort: job.reasoningEffort ?? undefined,
      blockingIssueNumber: parent.number,
      blockingIssueUrl: parent.url,
    });
    await queue.remove(payload.jobId);
    if (result.job && result.changed) {
      await events.record({
        type: "JOB_DEFERRED",
        message: `Deferred ${job.repository.fullName}#${job.issueNumber}: blocked by unresolved parent issue #${parent.number}`,
        jobId: result.job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: {
          issueUrl: job.issueUrl,
          blockingIssueNumber: parent.number,
          blockingIssueUrl: parent.url,
          withdrewQueued: true,
        },
      });
    }
    return false;
  };
}

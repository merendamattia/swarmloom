import type { Repository } from "@prisma/client";
import { configuredAgent } from "../providers/index.ts";
import { acquireIssue, queueJob, safeError, type ScannerShared } from "./common.ts";

export type IssueScannerDependencies = ScannerShared;

export function createIssueScanner(shared: ScannerShared) {
  const { config, github, events } = shared;

  async function run(repository: Repository, fullName: string, scanRunId: string) {
    const queued: Array<{ jobId: string; info: Parameters<typeof events.notifyQueuedSummary>[1][number] }> = [];
    const agent = configuredAgent(config);
    const issues = await github.listReadyIssues(fullName, config.ISSUE_READY_LABEL);
    for (const issue of issues) {
      const branchName = `agent/issue-${issue.number}-${crypto.randomUUID().slice(0, 8)}`;
      let queuedJob;
      try {
        queuedJob = await queueJob(shared, fullName, {
          repositoryId: repository.id,
          environment: config.APP_ENV,
          jobType: "IMPLEMENTATION",
          subjectType: "ISSUE",
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueUrl: issue.url,
          issueBody: issue.body,
          branchName,
          baselineCommit: repository.baselineCommit ?? "",
          trigger: "ISSUE_READY",
          provider: agent.provider,
          model: agent.model,
          reasoningEffort: agent.reasoningEffort,
        }, scanRunId);
      } catch (error) {
        await events.record({
          type: "JOB_FAILED",
          level: "ERROR",
          message: `Could not queue ${fullName}#${issue.number}: ${safeError(error)}`,
          repositoryId: repository.id,
          scanRunId,
          metadata: { issueUrl: issue.url, issueNumber: issue.number },
        });
        continue;
      }
      if (!queuedJob) continue;
      try {
        await acquireIssue(shared, fullName, issue.number, issue.labels);
      } catch (error) {
        await events.record({
          type: "JOB_FAILED",
          level: "ERROR",
          message: `Could not acquire ${fullName}#${issue.number} on GitHub`,
          jobId: queuedJob.jobId,
          repositoryId: repository.id,
          scanRunId,
          metadata: { issueUrl: issue.url, issueNumber: issue.number },
        });
        const { jobRepository } = await import("../repositories/jobs.ts");
        await jobRepository.failQueued(queuedJob.jobId, safeError(error));
        continue;
      }
      queued.push({ jobId: queuedJob.jobId, info: queuedJob.info });
      await events.record({
        type: "JOB_QUEUED",
        message: `Queued IMPLEMENTATION for ${fullName}#${issue.number} · ${issue.title}`,
        jobId: queuedJob.jobId,
        repositoryId: repository.id,
        scanRunId,
        metadata: { issueUrl: issue.url, issueNumber: issue.number },
      });
    }
    return queued;
  }

  return { run };
}

import type { Config } from "../core/config-schema.ts";
import type { GitHubClient } from "../github/client.ts";
import { supportIssueBody, supportIssueMarker, supportIssueTitle } from "../github/support-issues.ts";
import { jobRepository } from "../repositories/jobs.ts";

type SupportIssue = { number: number; url: string };

type SupportIssueDependencies = {
  config: Config;
  github: Pick<GitHubClient, "createIssue" | "findIssueByMarker">;
  jobId: string;
  environment?: string;
};

export type SupportIssueResult =
  | { kind: "missing" }
  | { kind: "not_failed" }
  | { kind: "in_progress" }
  | { kind: "existing"; issue: SupportIssue; repositoryId: string }
  | { kind: "created"; issue: SupportIssue; repositoryId: string }
  | { kind: "failed"; reason: "github" | "persistence"; error?: unknown };

export async function createSupportIssue({ config, github, jobId, environment = config.APP_ENV }: SupportIssueDependencies): Promise<SupportIssueResult> {
  const claim = await jobRepository.claimSupportIssue(jobId, environment);
  if (claim.kind === "existing") return { kind: "existing", issue: { number: claim.issueNumber, url: claim.issueUrl }, repositoryId: claim.repositoryId };
  if (claim.kind !== "claimed") return claim;

  if (claim.reconcile) {
    try {
      const existing = await github.findIssueByMarker(claim.job.repository.fullName, supportIssueMarker(jobId));
      if (existing) {
        try {
          if (await jobRepository.saveSupportIssue(jobId, environment, claim.claimedAt, existing)) {
            return { kind: "existing", issue: existing, repositoryId: claim.job.repositoryId };
          }
          const persisted = await jobRepository.findSupportIssue(jobId, environment);
          if (persisted) return { kind: "existing", issue: { number: persisted.issueNumber, url: persisted.issueUrl }, repositoryId: claim.job.repositoryId };
        } catch (error) {
          await markForReconciliation(jobId, environment, claim.claimedAt);
          return { kind: "failed", reason: "persistence", error };
        }
        await markForReconciliation(jobId, environment, claim.claimedAt);
        return { kind: "failed", reason: "persistence" };
      }
    } catch (error) {
      await markForReconciliation(jobId, environment, claim.claimedAt);
      return { kind: "failed", reason: "github", error };
    }
  }

  let issue: SupportIssue;
  try {
    issue = await github.createIssue(
      claim.job.repository.fullName,
      supportIssueTitle(claim.job, config),
      supportIssueBody(claim.job, config),
      [config.ISSUE_READY_LABEL],
    );
  } catch (error) {
    await releaseClaim(jobId, environment, claim.claimedAt);
    return { kind: "failed", reason: "github", error };
  }

  try {
    if (await jobRepository.saveSupportIssue(jobId, environment, claim.claimedAt, issue)) {
      return { kind: "created", issue, repositoryId: claim.job.repositoryId };
    }
    const persisted = await jobRepository.findSupportIssue(jobId, environment);
    if (persisted) return { kind: "existing", issue: { number: persisted.issueNumber, url: persisted.issueUrl }, repositoryId: claim.job.repositoryId };
  } catch (error) {
    await markForReconciliation(jobId, environment, claim.claimedAt);
    return { kind: "failed", reason: "persistence", error };
  }
  await markForReconciliation(jobId, environment, claim.claimedAt);
  return { kind: "failed", reason: "persistence" };
}

async function releaseClaim(id: string, environment: string, claimedAt: Date) {
  try {
    await jobRepository.releaseSupportIssue(id, environment, claimedAt);
  } catch {
    // The lease remains recoverable when the release itself cannot be persisted.
  }
}

async function markForReconciliation(id: string, environment: string, claimedAt: Date) {
  try {
    await jobRepository.markSupportIssueForReconciliation(id, environment, claimedAt);
  } catch {
    // The lease timestamp still makes the claim recoverable after a process restart.
  }
}

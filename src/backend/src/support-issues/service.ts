import type { Config } from "../core/config-schema.ts";
import type { GitHubClient } from "../github/client.ts";
import { supportIssueBody, supportIssueMarker, supportIssueTitle, type SupportIssueOrigin } from "../github/support-issues.ts";
import { jobRepository, SUPPORT_ISSUE_LEASE_MS } from "../repositories/jobs.ts";

type SupportIssue = { number: number; url: string };

type SupportIssueDependencies = {
  config: Config;
  github: Pick<GitHubClient, "createIssue" | "findIssueByMarker">;
  jobId: string;
  environment?: string;
  origin?: SupportIssueOrigin;
  leaseMs?: number;
  leaseRenewalIntervalMs?: number;
};

const SUPPORT_ISSUE_REQUEST_TIMEOUT_MS = 4 * 60_000;
const SUPPORT_ISSUE_RENEWAL_INTERVAL_MS = Math.min(SUPPORT_ISSUE_LEASE_MS / 3, 60_000);

type ClaimedSupportIssue = Extract<Awaited<ReturnType<typeof jobRepository.claimSupportIssue>>, { kind: "claimed" }>;

async function runWithSupportIssueLease<T>(
  claim: ClaimedSupportIssue,
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    jobId: string;
    environment: string;
    renewalIntervalMs: number;
    requestTimeoutMs: number;
  },
) {
  const controller = new AbortController();
  let claimedAt = claim.claimedAt;
  let leaseLost = false;
  let renewal = Promise.resolve();
  const renew = () => {
    renewal = renewal.then(async () => {
      if (leaseLost) return;
      try {
        const renewedAt = await jobRepository.renewSupportIssue(options.jobId, options.environment, claimedAt);
        if (!renewedAt) {
          leaseLost = true;
          controller.abort(new Error("Support issue claim was lost"));
          return;
        }
        claimedAt = renewedAt;
      } catch (error) {
        leaseLost = true;
        controller.abort(error);
      }
    });
  };
  const renewalTimer = setInterval(renew, options.renewalIntervalMs);
  const timeoutTimer = setTimeout(
    () => controller.abort(new Error("GitHub support issue request timed out")),
    options.requestTimeoutMs,
  );
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    result = { ok: true, value: await operation(controller.signal) };
  } catch (error) {
    result = { ok: false, error };
  } finally {
    clearInterval(renewalTimer);
    clearTimeout(timeoutTimer);
    await renewal;
  }
  return { ...result, claimedAt, leaseLost, aborted: controller.signal.aborted };
}

export type SupportIssueResult =
  | { kind: "missing" }
  | { kind: "not_failed" }
  | { kind: "in_progress" }
  | { kind: "existing"; issue: SupportIssue; repositoryId: string }
  | { kind: "created"; issue: SupportIssue; repositoryId: string }
  | { kind: "failed"; reason: "github" | "persistence"; error?: unknown };

export async function createSupportIssue({
  config,
  github,
  jobId,
  environment = config.APP_ENV,
  origin = "manual",
  leaseMs = SUPPORT_ISSUE_LEASE_MS,
  leaseRenewalIntervalMs = SUPPORT_ISSUE_RENEWAL_INTERVAL_MS,
}: SupportIssueDependencies): Promise<SupportIssueResult> {
  const claim = await jobRepository.claimSupportIssue(jobId, environment, leaseMs);
  if (claim.kind === "existing") return { kind: "existing", issue: { number: claim.issueNumber, url: claim.issueUrl }, repositoryId: claim.repositoryId };
  if (claim.kind !== "claimed") return claim;

  if (claim.reconcile) {
    const lookup = await runWithSupportIssueLease(
      claim,
      (signal) => github.findIssueByMarker(claim.job.repository.fullName, supportIssueMarker(jobId), signal),
      { jobId, environment, renewalIntervalMs: leaseRenewalIntervalMs, requestTimeoutMs: SUPPORT_ISSUE_REQUEST_TIMEOUT_MS },
    );
    if (lookup.ok && !lookup.leaseLost && !lookup.aborted) {
      const existing = lookup.value;
      if (existing) {
        try {
          if (await jobRepository.saveSupportIssue(jobId, environment, lookup.claimedAt, existing)) {
            return { kind: "existing", issue: existing, repositoryId: claim.job.repositoryId };
          }
          const persisted = await jobRepository.findSupportIssue(jobId, environment);
          if (persisted) return { kind: "existing", issue: { number: persisted.issueNumber, url: persisted.issueUrl }, repositoryId: claim.job.repositoryId };
        } catch (error) {
          await markForReconciliation(jobId, environment, lookup.claimedAt);
          return { kind: "failed", reason: "persistence", error };
        }
        await markForReconciliation(jobId, environment, lookup.claimedAt);
        return { kind: "failed", reason: "persistence" };
      }
      claim.claimedAt = lookup.claimedAt;
    } else {
      await markForReconciliation(jobId, environment, lookup.claimedAt);
      return { kind: "failed", reason: "github", error: lookup.ok ? undefined : lookup.error };
    }
  }

  const creation = await runWithSupportIssueLease(
    claim,
    (signal) => github.createIssue(
      claim.job.repository.fullName,
      supportIssueTitle(claim.job, config),
      supportIssueBody(claim.job, config, origin),
      [config.ISSUE_READY_LABEL],
      signal,
    ),
    { jobId, environment, renewalIntervalMs: leaseRenewalIntervalMs, requestTimeoutMs: SUPPORT_ISSUE_REQUEST_TIMEOUT_MS },
  );
  if (!creation.ok || creation.leaseLost || creation.aborted) {
    await markForReconciliation(jobId, environment, creation.claimedAt);
    return { kind: "failed", reason: "github", error: creation.ok ? undefined : creation.error };
  }

  try {
    if (await jobRepository.saveSupportIssue(jobId, environment, creation.claimedAt, creation.value)) {
      return { kind: "created", issue: creation.value, repositoryId: claim.job.repositoryId };
    }
    const persisted = await jobRepository.findSupportIssue(jobId, environment);
    if (persisted) return { kind: "existing", issue: { number: persisted.issueNumber, url: persisted.issueUrl }, repositoryId: claim.job.repositoryId };
  } catch (error) {
    await markForReconciliation(jobId, environment, creation.claimedAt);
    return { kind: "failed", reason: "persistence", error };
  }
  await markForReconciliation(jobId, environment, creation.claimedAt);
  return { kind: "failed", reason: "persistence" };
}

async function markForReconciliation(id: string, environment: string, claimedAt: Date) {
  try {
    await jobRepository.markSupportIssueForReconciliation(id, environment, claimedAt);
  } catch {
    // The lease timestamp still makes the claim recoverable after a process restart.
  }
}

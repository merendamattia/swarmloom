import type { Config } from "../core/config-schema.ts";
import { redactSecrets } from "../core/secrets.ts";
import type { EventService } from "../events/service.ts";
import { removeJobWorktree, repositoryPath } from "../git/repositories.ts";
import { jobRepository } from "../repositories/jobs.ts";

type CancelledWorktreeJob = {
  id: string;
  repositoryId: string;
  issueNumber: number;
  issueUrl: string;
  scanRunId: string | null;
  worktreePath: string | null;
  workerId: string | null;
  claimToken: string | null;
  repository: { fullName: string; localPath: string | null };
};

type RemoveWorktree = typeof removeJobWorktree;

export async function cleanupCancelledWorktree(
  config: Config,
  events: Pick<EventService, "record">,
  job: CancelledWorktreeJob,
  removeWorktree: RemoveWorktree = removeJobWorktree,
) {
  if (!job.worktreePath) return false;
  try {
    const cleanup = await jobRepository.claimWorktreeCleanup(job.id, job.workerId, job.claimToken, job.worktreePath);
    if (!cleanup) return false;
    await removeWorktree({
      worktreePath: cleanup.path,
      repositoryPath: job.repository.localPath ?? repositoryPath(config.DATA_DIR, job.repository.fullName),
      gitEnvironment: undefined,
    });
    const cleared = await jobRepository.clearWorktree(job.id, job.claimToken, cleanup.cleanupToken);
    if (!cleared) return false;
    await jobRepository.releaseWorker(job.id, job.workerId, job.claimToken);
    return true;
  } catch (error) {
    await events.record({
      type: "WORKTREE_CLEANUP_REQUIRED",
      level: "ERROR",
      message: `Could not remove cancelled job worktree ${job.worktreePath}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: { issueUrl: job.issueUrl },
    });
    return false;
  }
}

export async function recoverCancelledWorktrees(
  config: Config,
  events: EventService,
  removeWorktree: RemoveWorktree = removeJobWorktree,
) {
  const staleBefore = new Date(Date.now() - config.STALE_JOB_THRESHOLD_MS);
  const jobs = await jobRepository.findCancelledWorktrees(config.APP_ENV, staleBefore);
  let recovered = 0;
  for (const job of jobs) {
    if (await cleanupCancelledWorktree(config, events, job, removeWorktree)) recovered += 1;
  }
  return recovered;
}

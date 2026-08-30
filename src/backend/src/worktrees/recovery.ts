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
    await removeWorktree({
      worktreePath: job.worktreePath,
      repositoryPath: job.repository.localPath ?? repositoryPath(config.DATA_DIR, job.repository.fullName),
      gitEnvironment: undefined,
    });
    return await jobRepository.markWorktreeCleaned(job.id, config.APP_ENV);
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
  const jobs = await jobRepository.findCancelledWorktrees(config.APP_ENV);
  let recovered = 0;
  for (const job of jobs) {
    if (await cleanupCancelledWorktree(config, events, job, removeWorktree)) recovered += 1;
  }
  return recovered;
}

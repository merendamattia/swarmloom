import { type JobStatus } from "@prisma/client";
import { prisma } from "../core/db.ts";
import { jobRepository } from "./jobs.ts";

async function upsertConfigured(fullName: string, cloneUrl: string) {
  return prisma.repository.upsert({
    where: { fullName },
    create: { fullName, cloneUrl },
    update: cloneUrl ? { cloneUrl } : {},
  });
}

async function markReady(id: string, localPath: string, baselineCommit: string) {
  return prisma.repository.update({
    where: { id },
    data: {
      status: "READY",
      localPath,
      baselineCommit,
      developAvailable: true,
      lastScannedAt: new Date(),
      errorMessage: null,
    },
  });
}

async function markInvalid(id: string, errorMessage: string) {
  return prisma.repository.update({
    where: { id },
    data: {
      status: "INVALID",
      developAvailable: false,
      lastScannedAt: new Date(),
      errorMessage,
    },
  });
}

async function markError(id: string, errorMessage: string) {
  return prisma.repository.update({
    where: { id },
    data: { status: "ERROR", lastScannedAt: new Date(), errorMessage },
  });
}

type RemoveConfiguration = { environment: string; value: string | null };
type RemoveWorktree = (worktreePath: string) => Promise<void>;
const terminalJobStatuses: JobStatus[] = ["COMPLETED", "FAILED", "BLOCKED", "DECOMPOSED", "CANCELLED", "STALE"];
type RemoveResult = {
  blocked?: boolean;
  activeJobs?: number;
  cleanupRequired?: boolean;
  cleanupFailed?: boolean;
  removed?: boolean;
  fullName?: string;
};

async function remove(
  id: string,
  fullName: string,
  configuration?: RemoveConfiguration,
  removeWorktree?: RemoveWorktree,
): Promise<RemoveResult> {
  const activeJobs = await prisma.job.count({
    where: {
      repositoryId: id,
      OR: [
        { status: { in: ["QUEUED", "RUNNING", "WAITING_FOR_QUOTA"] } },
        { worktreeCleanupRequired: true },
        { status: "FAILED", worktreePath: { not: null } },
        { status: { in: terminalJobStatuses }, OR: [{ workerId: { not: null } }, { claimToken: { not: null } }] },
      ],
    },
  });
  if (activeJobs > 0) return { blocked: true, activeJobs };

  const retainedJobs = await prisma.job.findMany({
    where: { repositoryId: id, worktreePath: { not: null } },
    select: { id: true, worktreePath: true, workerId: true, claimToken: true, status: true },
  });
  if (retainedJobs.length > 0) {
    if (!removeWorktree) return { cleanupRequired: true };
    for (const job of retainedJobs) {
      if (!job.worktreePath) continue;
      const cleanup = await jobRepository.claimWorktreeCleanup(
        job.id,
        job.workerId,
        job.claimToken,
        job.worktreePath,
      );
      if (!cleanup) return { cleanupRequired: true };
      try {
        await removeWorktree(cleanup.path);
      } catch {
        return { cleanupFailed: true };
      }
      if (!await jobRepository.clearWorktree(job.id, job.claimToken, cleanup.cleanupToken)) {
        return { cleanupRequired: true };
      }
      await jobRepository.releaseWorker(job.id, job.workerId, job.claimToken, job.status === "STALE");
    }
  }

  const settingsWrite = configuration
    ? configuration.value === null
      ? prisma.runtimeSetting.deleteMany({
          where: { environment: configuration.environment, key: "GITHUB_REPOSITORIES" },
        })
      : prisma.runtimeSetting.upsert({
          where: { environment_key: { environment: configuration.environment, key: "GITHUB_REPOSITORIES" } },
          create: {
            environment: configuration.environment,
            key: "GITHUB_REPOSITORIES",
            value: configuration.value,
            secret: false,
          },
          update: { value: configuration.value },
        })
    : null;
  await prisma.$transaction([
    prisma.jobEvent.deleteMany({ where: { repositoryId: id } }),
    prisma.job.deleteMany({ where: { repositoryId: id } }),
    prisma.managedPullRequest.deleteMany({ where: { repositoryId: id } }),
    prisma.repository.delete({ where: { id } }),
    ...(settingsWrite ? [settingsWrite] : []),
  ]);
  return { removed: true, fullName };
}

export const repositoryRepository = { upsertConfigured, markReady, markInvalid, markError, remove };

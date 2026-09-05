import { prisma } from "../core/db.ts";

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

async function remove(id: string, fullName: string, configuration?: RemoveConfiguration) {
  const activeJobs = await prisma.job.count({
    where: {
      repositoryId: id,
      OR: [
        { status: { in: ["QUEUED", "RUNNING", "WAITING_FOR_QUOTA"] } },
        { worktreePath: { not: null } },
        { worktreeCleanupRequired: true },
        { worktreePath: { not: null } },
      ],
    },
  });
  if (activeJobs > 0) return { blocked: true, activeJobs };
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

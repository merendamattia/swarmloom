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

async function remove(id: string) {
  const repository = await prisma.repository.findUnique({ where: { id }, select: { fullName: true } });
  if (!repository) return null;
  const activeJobs = await prisma.job.count({
    where: { repositoryId: id, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (activeJobs > 0) return { blocked: true, activeJobs };
  await prisma.$transaction([
    prisma.jobEvent.deleteMany({ where: { repositoryId: id } }),
    prisma.job.deleteMany({ where: { repositoryId: id } }),
    prisma.repository.delete({ where: { id } }),
  ]);
  return { removed: true, fullName: repository.fullName };
}

export const repositoryRepository = { upsertConfigured, markReady, markInvalid, markError, remove };

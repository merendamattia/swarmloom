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

export const repositoryRepository = { upsertConfigured, markReady, markInvalid, markError };

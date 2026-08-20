import type { ManagedPrState, ManagedPrWorkflow } from "@prisma/client";
import { prisma } from "../core/db.ts";

type UpsertManagedPrInput = {
  repositoryId: string;
  prNumber: number;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  implementationJobId?: string;
};

async function upsertFromImplementation(input: UpsertManagedPrInput) {
  const [row] = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "managed_pull_request" (
      "id", "repositoryId", "prNumber", "issueNumber", "issueTitle", "issueUrl",
      "headBranch", "headSha", "baseBranch", "implementationJobId", "state", "workflow",
      "lastObservedAt", "updatedAt"
    ) VALUES (
      ${crypto.randomUUID()}, ${input.repositoryId}, ${input.prNumber}, ${input.issueNumber},
      ${input.issueTitle}, ${input.issueUrl}, ${input.headBranch}, ${input.headSha},
      ${input.baseBranch}, ${input.implementationJobId ?? null}, 'OPEN', 'NONE',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("repositoryId", "prNumber") DO UPDATE
    SET "issueNumber" = EXCLUDED."issueNumber",
        "issueTitle" = EXCLUDED."issueTitle",
        "issueUrl" = EXCLUDED."issueUrl",
        "headBranch" = EXCLUDED."headBranch",
        "headSha" = EXCLUDED."headSha",
        "baseBranch" = EXCLUDED."baseBranch",
        "state" = 'OPEN',
        "lastObservedAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "id"
  `;
  return row?.id ?? null;
}

async function findOpen(repositoryId: string) {
  return prisma.managedPullRequest.findMany({
    where: { repositoryId, state: "OPEN" },
    orderBy: { prNumber: "asc" },
  });
}

async function findByRepositoryAndNumber(repositoryId: string, prNumber: number) {
  return prisma.managedPullRequest.findUnique({
    where: { repositoryId_prNumber: { repositoryId, prNumber } },
  });
}

async function updateHead(repositoryId: string, prNumber: number, headBranch: string, headSha: string) {
  await prisma.managedPullRequest.updateMany({
    where: { repositoryId, prNumber },
    data: { headBranch, headSha, lastObservedAt: new Date() },
  });
}

async function setWorkflow(
  repositoryId: string,
  prNumber: number,
  workflow: ManagedPrWorkflow,
  input: { fixReason?: string | null; fixDetails?: string | null } = {},
) {
  await prisma.managedPullRequest.updateMany({
    where: { repositoryId, prNumber },
    data: {
      workflow,
      ...(input.fixReason !== undefined ? { fixReason: input.fixReason } : {}),
      ...(input.fixDetails !== undefined ? { fixDetails: input.fixDetails } : {}),
      lastObservedAt: new Date(),
    },
  });
}

async function incrementFixCycle(repositoryId: string, prNumber: number) {
  const updated = await prisma.managedPullRequest.updateMany({
    where: { repositoryId, prNumber },
    data: { fixCycleCount: { increment: 1 } },
  });
  if (updated.count === 0) return null;
  return (await findByRepositoryAndNumber(repositoryId, prNumber))?.fixCycleCount ?? null;
}

async function resetFixCycle(repositoryId: string, prNumber: number) {
  await prisma.managedPullRequest.updateMany({
    where: { repositoryId, prNumber },
    data: { fixCycleCount: 0 },
  });
}

async function block(repositoryId: string, prNumber: number) {
  await prisma.managedPullRequest.updateMany({
    where: { repositoryId, prNumber },
    data: { blocked: true, lastObservedAt: new Date() },
  });
}

async function unblock(repositoryId: string, prNumber: number) {
  await prisma.managedPullRequest.updateMany({
    where: { repositoryId, prNumber },
    data: { blocked: false, fixCycleCount: 0, lastObservedAt: new Date() },
  });
}

async function markState(repositoryId: string, prNumber: number, state: ManagedPrState) {
  await prisma.managedPullRequest.updateMany({
    where: { repositoryId, prNumber },
    data: { state, lastObservedAt: new Date() },
  });
}

export const managedPullRequestRepository = {
  upsertFromImplementation,
  findOpen,
  findByRepositoryAndNumber,
  updateHead,
  setWorkflow,
  incrementFixCycle,
  resetFixCycle,
  block,
  unblock,
  markState,
};

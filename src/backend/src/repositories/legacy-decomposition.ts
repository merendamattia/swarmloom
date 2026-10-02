import { prisma } from "../core/db.ts";

export const LEGACY_DECOMPOSITION_STOP_REASON =
  "The decomposition workflow was removed; this issue requires human intervention.";

const CLAIM_LEASE_MS = 5 * 60_000;

async function findPending(environment: string) {
  return prisma.job.findMany({
    where: {
      environment,
      jobType: "DECOMPOSITION",
      status: "BLOCKED",
      errorMessage: LEGACY_DECOMPOSITION_STOP_REASON,
      legacyDecompositionReconciledAt: null,
    },
    include: { repository: true },
  });
}

async function claim(id: string) {
  const token = crypto.randomUUID();
  const now = new Date();
  const result = await prisma.job.updateMany({
    where: {
      id,
      legacyDecompositionReconciledAt: null,
      OR: [
        { legacyDecompositionClaimToken: null },
        { legacyDecompositionClaimedAt: { lt: new Date(now.getTime() - CLAIM_LEASE_MS) } },
      ],
    },
    data: { legacyDecompositionClaimToken: token, legacyDecompositionClaimedAt: now },
  });
  return result.count ? token : null;
}

async function finish(id: string, token: string) {
  await prisma.job.updateMany({
    where: { id, legacyDecompositionClaimToken: token },
    data: {
      legacyDecompositionReconciledAt: new Date(),
      legacyDecompositionClaimToken: null,
      legacyDecompositionClaimedAt: null,
    },
  });
}

async function release(id: string, token: string) {
  await prisma.job.updateMany({
    where: { id, legacyDecompositionClaimToken: token },
    data: { legacyDecompositionClaimToken: null, legacyDecompositionClaimedAt: null },
  });
}

export const legacyDecompositionRepository = { findPending, claim, finish, release };

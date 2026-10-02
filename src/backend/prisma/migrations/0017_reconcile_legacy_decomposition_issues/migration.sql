-- The preceding migration records why unfinished decomposition jobs stopped.
-- These fields let workers finish the corresponding GitHub update after deployment.
ALTER TABLE "job"
  ADD COLUMN "legacyDecompositionReconciledAt" TIMESTAMP(3),
  ADD COLUMN "legacyDecompositionClaimToken" TEXT,
  ADD COLUMN "legacyDecompositionClaimedAt" TIMESTAMP(3);

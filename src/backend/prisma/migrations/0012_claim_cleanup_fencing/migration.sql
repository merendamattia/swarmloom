ALTER TABLE "job"
  ADD COLUMN "cleanupLeaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "review"
  ADD COLUMN "claimToken" TEXT;

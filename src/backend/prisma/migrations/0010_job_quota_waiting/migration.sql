ALTER TABLE "job" RENAME COLUMN "implementationSessionId" TO "sessionId";
ALTER TABLE "job" DROP COLUMN "queueJobId";

ALTER TYPE "JobStatus" ADD VALUE 'WAITING_FOR_QUOTA';

ALTER TABLE "job"
  ADD COLUMN "activeStartedAt" TIMESTAMP(3),
  ADD COLUMN "activeDurationMs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "quotaWaitDurationMs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "quotaWaitStartedAt" TIMESTAMP(3),
  ADD COLUMN "quotaResetAt" TIMESTAMP(3),
  ADD COLUMN "quotaWindow" TEXT,
  ADD COLUMN "quotaUsedPercent" DOUBLE PRECISION,
  ADD COLUMN "quotaMessage" TEXT;

UPDATE "job"
SET "activeDurationMs" = "durationMs"
WHERE "durationMs" IS NOT NULL;

CREATE INDEX "job_environment_status_quotaWaitStartedAt_idx"
  ON "job"("environment", "status", "quotaWaitStartedAt");

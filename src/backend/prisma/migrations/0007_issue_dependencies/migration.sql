ALTER TYPE "JobStatus" ADD VALUE 'DEFERRED';

ALTER TABLE "job" ADD COLUMN "blockedByIssueNumber" INTEGER;
ALTER TABLE "job" ADD COLUMN "blockedByIssueTitle" TEXT;
ALTER TABLE "job" ADD COLUMN "blockedByIssueUrl" TEXT;
ALTER TABLE "job" ADD COLUMN "blockedReason" TEXT;

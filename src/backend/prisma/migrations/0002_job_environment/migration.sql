ALTER TABLE "job" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "job" ALTER COLUMN "environment" DROP DEFAULT;
DROP INDEX "job_status_queuedAt_idx";
CREATE INDEX "job_environment_status_queuedAt_idx" ON "job"("environment", "status", "queuedAt");

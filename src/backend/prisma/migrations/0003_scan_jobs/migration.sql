ALTER TABLE "scan_run" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "scan_run" ALTER COLUMN "environment" DROP DEFAULT;
ALTER TABLE "job" ADD COLUMN "scanRunId" TEXT;
ALTER TABLE "job" ADD CONSTRAINT "job_scanRunId_fkey" FOREIGN KEY ("scanRunId") REFERENCES "scan_run"("id") ON DELETE SET NULL;
DROP INDEX "scan_run_startedAt_idx";
CREATE INDEX "scan_run_environment_startedAt_idx" ON "scan_run"("environment", "startedAt");
CREATE INDEX "job_scanRunId_status_idx" ON "job"("scanRunId", "status");

ALTER TABLE "scan_run" ADD COLUMN "activeEnvironmentKey" TEXT;
CREATE UNIQUE INDEX "scan_run_activeEnvironmentKey_key" ON "scan_run"("activeEnvironmentKey");

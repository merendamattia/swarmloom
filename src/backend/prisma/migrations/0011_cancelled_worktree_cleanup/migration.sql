ALTER TABLE "job"
  ADD COLUMN "worktreeCleanupRequired" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "job_environment_status_worktreeCleanupRequired_idx"
  ON "job"("environment", "status", "worktreeCleanupRequired");

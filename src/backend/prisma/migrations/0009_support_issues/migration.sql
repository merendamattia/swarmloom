ALTER TABLE "job"
  ADD COLUMN "supportIssueNumber" INTEGER,
  ADD COLUMN "supportIssueUrl" TEXT,
  ADD COLUMN "supportIssueCreating" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "supportIssueCreatingAt" TIMESTAMP(3),
  ADD COLUMN "supportIssueReconcileRequired" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "job"
  ADD COLUMN "supportIssueNumber" INTEGER,
  ADD COLUMN "supportIssueUrl" TEXT,
  ADD COLUMN "supportIssueCreating" BOOLEAN NOT NULL DEFAULT false;

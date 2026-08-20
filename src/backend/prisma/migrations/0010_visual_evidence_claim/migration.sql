ALTER TABLE "managed_pull_request"
  ADD COLUMN "visualVerification" JSONB,
  ADD COLUMN "visualEvidenceKey" TEXT,
  ADD COLUMN "visualEvidencePublishedAt" TIMESTAMP(3);

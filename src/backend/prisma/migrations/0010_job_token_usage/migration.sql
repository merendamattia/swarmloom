ALTER TABLE "job"
  ADD COLUMN "inputTokens" INTEGER,
  ADD COLUMN "cachedInputTokens" INTEGER,
  ADD COLUMN "outputTokens" INTEGER,
  ADD COLUMN "reasoningOutputTokens" INTEGER,
  ADD COLUMN "totalTokens" INTEGER,
  ADD COLUMN "tokenUsageUpdatedAt" TIMESTAMP(3);

ALTER TABLE "job"
  ADD COLUMN "inputTokens" BIGINT,
  ADD COLUMN "cachedInputTokens" BIGINT,
  ADD COLUMN "outputTokens" BIGINT,
  ADD COLUMN "reasoningOutputTokens" BIGINT,
  ADD COLUMN "totalTokens" BIGINT,
  ADD COLUMN "tokenUsageUpdatedAt" TIMESTAMP(3);

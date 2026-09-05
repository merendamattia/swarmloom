CREATE TABLE "codex_model" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "defaultReasoningEffort" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "codex_model_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "codex_reasoning_effort" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "codex_reasoning_effort_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "codex_model_reasoning_effort" (
  "modelId" TEXT NOT NULL,
  "reasoningEffortId" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "codex_model_reasoning_effort_pkey" PRIMARY KEY ("modelId", "reasoningEffortId")
);

CREATE UNIQUE INDEX "codex_model_slug_key" ON "codex_model"("slug");
CREATE INDEX "codex_model_enabled_sortOrder_idx" ON "codex_model"("enabled", "sortOrder");
CREATE UNIQUE INDEX "codex_reasoning_effort_slug_key" ON "codex_reasoning_effort"("slug");
CREATE INDEX "codex_reasoning_effort_enabled_sortOrder_idx" ON "codex_reasoning_effort"("enabled", "sortOrder");
CREATE INDEX "codex_model_reasoning_effort_reasoningEffortId_idx" ON "codex_model_reasoning_effort"("reasoningEffortId");

ALTER TABLE "codex_model_reasoning_effort"
  ADD CONSTRAINT "codex_model_reasoning_effort_modelId_fkey"
  FOREIGN KEY ("modelId") REFERENCES "codex_model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "codex_model_reasoning_effort"
  ADD CONSTRAINT "codex_model_reasoning_effort_reasoningEffortId_fkey"
  FOREIGN KEY ("reasoningEffortId") REFERENCES "codex_reasoning_effort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "codex_reasoning_effort" ("id", "slug", "label", "sortOrder", "updatedAt") VALUES
  ('codex-effort-none', 'none', 'None', 0, CURRENT_TIMESTAMP),
  ('codex-effort-low', 'low', 'Low', 1, CURRENT_TIMESTAMP),
  ('codex-effort-medium', 'medium', 'Medium', 2, CURRENT_TIMESTAMP),
  ('codex-effort-high', 'high', 'High', 3, CURRENT_TIMESTAMP),
  ('codex-effort-xhigh', 'xhigh', 'Extra high', 4, CURRENT_TIMESTAMP),
  ('codex-effort-max', 'max', 'Max', 5, CURRENT_TIMESTAMP);

INSERT INTO "codex_model" ("id", "slug", "label", "description", "sortOrder", "defaultReasoningEffort", "updatedAt") VALUES
  ('codex-model-gpt-5-6-luna', 'gpt-5.6-luna', 'GPT-5.6 Luna', 'GPT-5.6 Luna Codex model.', 0, 'max', CURRENT_TIMESTAMP),
  ('codex-model-gpt-5-6-terra', 'gpt-5.6-terra', 'GPT-5.6 Terra', 'GPT-5.6 Terra Codex model.', 1, 'max', CURRENT_TIMESTAMP),
  ('codex-model-gpt-5-6-sol', 'gpt-5.6-sol', 'GPT-5.6 Sol', 'GPT-5.6 Sol Codex model.', 2, 'max', CURRENT_TIMESTAMP),
  ('codex-model-gpt-6-astra', 'gpt-6-astra', 'GPT-6 Astra', 'GPT-6 Astra Codex model.', 3, 'max', CURRENT_TIMESTAMP);

INSERT INTO "codex_model_reasoning_effort" ("modelId", "reasoningEffortId", "isDefault") VALUES
  ('codex-model-gpt-5-6-luna', 'codex-effort-none', false),
  ('codex-model-gpt-5-6-luna', 'codex-effort-low', false),
  ('codex-model-gpt-5-6-luna', 'codex-effort-medium', false),
  ('codex-model-gpt-5-6-luna', 'codex-effort-high', false),
  ('codex-model-gpt-5-6-luna', 'codex-effort-xhigh', false),
  ('codex-model-gpt-5-6-luna', 'codex-effort-max', true),
  ('codex-model-gpt-5-6-terra', 'codex-effort-none', false),
  ('codex-model-gpt-5-6-terra', 'codex-effort-low', false),
  ('codex-model-gpt-5-6-terra', 'codex-effort-medium', false),
  ('codex-model-gpt-5-6-terra', 'codex-effort-high', false),
  ('codex-model-gpt-5-6-terra', 'codex-effort-xhigh', false),
  ('codex-model-gpt-5-6-terra', 'codex-effort-max', true),
  ('codex-model-gpt-5-6-sol', 'codex-effort-none', false),
  ('codex-model-gpt-5-6-sol', 'codex-effort-low', false),
  ('codex-model-gpt-5-6-sol', 'codex-effort-medium', false),
  ('codex-model-gpt-5-6-sol', 'codex-effort-high', false),
  ('codex-model-gpt-5-6-sol', 'codex-effort-xhigh', false),
  ('codex-model-gpt-5-6-sol', 'codex-effort-max', true),
  ('codex-model-gpt-6-astra', 'codex-effort-low', false),
  ('codex-model-gpt-6-astra', 'codex-effort-medium', false),
  ('codex-model-gpt-6-astra', 'codex-effort-high', false),
  ('codex-model-gpt-6-astra', 'codex-effort-xhigh', false),
  ('codex-model-gpt-6-astra', 'codex-effort-max', true);

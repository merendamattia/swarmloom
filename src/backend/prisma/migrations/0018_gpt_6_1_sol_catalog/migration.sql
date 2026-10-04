INSERT INTO "codex_model" ("id", "slug", "label", "description", "sortOrder", "defaultReasoningEffort", "updatedAt") VALUES
  ('codex-model-gpt-6-1-sol', 'gpt-6.1-sol', 'GPT-6.1 Sol', 'GPT-6.1 Sol Codex model.', 1, 'medium', CURRENT_TIMESTAMP);

INSERT INTO "codex_model_reasoning_effort" ("modelId", "reasoningEffortId", "isDefault") VALUES
  ('codex-model-gpt-6-1-sol', 'codex-effort-none', false),
  ('codex-model-gpt-6-1-sol', 'codex-effort-low', false),
  ('codex-model-gpt-6-1-sol', 'codex-effort-medium', true),
  ('codex-model-gpt-6-1-sol', 'codex-effort-high', false),
  ('codex-model-gpt-6-1-sol', 'codex-effort-xhigh', false),
  ('codex-model-gpt-6-1-sol', 'codex-effort-max', false);

UPDATE "codex_model"
SET "enabled" = "slug" IN ('gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'),
    "sortOrder" = CASE "slug"
      WHEN 'gpt-6-luna' THEN 0
      WHEN 'gpt-6.1-sol' THEN 1
      WHEN 'gpt-6-astra' THEN 2
      ELSE "sortOrder"
    END,
    "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "runtime_setting" AS effort
SET "value" = 'medium', "updatedAt" = CURRENT_TIMESTAMP
WHERE effort."key" IN ('CODEX_CODING_REASONING_EFFORT', 'CODEX_REVIEW_REASONING_EFFORT')
  AND EXISTS (
    SELECT 1 FROM "runtime_setting" AS model
    WHERE model."environment" = effort."environment"
      AND model."key" = CASE effort."key"
        WHEN 'CODEX_CODING_REASONING_EFFORT' THEN 'CODEX_CODING_MODEL'
        ELSE 'CODEX_REVIEW_MODEL'
      END
      AND model."value" IN ('gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-sol')
  );

UPDATE "runtime_setting"
SET "value" = 'gpt-6.1-sol', "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('CODEX_CODING_MODEL', 'CODEX_REVIEW_MODEL')
  AND "value" IN ('gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-sol');

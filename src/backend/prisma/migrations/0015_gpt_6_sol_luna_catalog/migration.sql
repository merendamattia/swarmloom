INSERT INTO "codex_model" ("id", "slug", "label", "description", "sortOrder", "defaultReasoningEffort", "updatedAt") VALUES
  ('codex-model-gpt-6-sol', 'gpt-6-sol', 'GPT-6 Sol', 'GPT-6 Sol Codex model.', 4, 'max', CURRENT_TIMESTAMP),
  ('codex-model-gpt-6-luna', 'gpt-6-luna', 'GPT-6 Luna', 'GPT-6 Luna Codex model.', 5, 'max', CURRENT_TIMESTAMP);

INSERT INTO "codex_model_reasoning_effort" ("modelId", "reasoningEffortId", "isDefault") VALUES
  ('codex-model-gpt-6-sol', 'codex-effort-none', false),
  ('codex-model-gpt-6-sol', 'codex-effort-low', false),
  ('codex-model-gpt-6-sol', 'codex-effort-medium', false),
  ('codex-model-gpt-6-sol', 'codex-effort-high', false),
  ('codex-model-gpt-6-sol', 'codex-effort-xhigh', false),
  ('codex-model-gpt-6-sol', 'codex-effort-max', true),
  ('codex-model-gpt-6-luna', 'codex-effort-none', false),
  ('codex-model-gpt-6-luna', 'codex-effort-low', false),
  ('codex-model-gpt-6-luna', 'codex-effort-medium', false),
  ('codex-model-gpt-6-luna', 'codex-effort-high', false),
  ('codex-model-gpt-6-luna', 'codex-effort-xhigh', false),
  ('codex-model-gpt-6-luna', 'codex-effort-max', true);

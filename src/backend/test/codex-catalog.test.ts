import { describe, expect, test } from "bun:test";
import {
  validateCodexConfig,
  validateCodexSelection,
  type CodexGenerationOptions,
} from "../src/core/codex-catalog.ts";

const catalog: CodexGenerationOptions = {
  models: [
    {
      slug: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      description: "GPT-5.6 Luna Codex model.",
      defaultReasoningEffort: "max",
      reasoningEfforts: [
        { slug: "none", label: "None", isDefault: false },
        { slug: "high", label: "High", isDefault: false },
        { slug: "max", label: "Max", isDefault: true },
      ],
    },
    {
      slug: "gpt-6-astra",
      label: "GPT-6 Astra",
      description: "GPT-6 Astra Codex model.",
      defaultReasoningEffort: "max",
      reasoningEfforts: [
        { slug: "low", label: "Low", isDefault: false },
        { slug: "max", label: "Max", isDefault: true },
      ],
    },
  ],
};

describe("Codex catalog validation", () => {
  test("does not validate unused Codex settings when OpenCode is active", async () => {
    await expect(validateCodexConfig({
      AGENT_PROVIDER: "opencode",
      CODEX_CODING_MODEL: "legacy-coding-model",
      CODEX_REVIEW_MODEL: "legacy-review-model",
      CODEX_CODING_REASONING_EFFORT: "minimal",
      CODEX_REVIEW_REASONING_EFFORT: "legacy-effort",
    })).resolves.toBeUndefined();
  });

  test("accepts a supported model and effort pair", () => {
    expect(validateCodexSelection(catalog, "gpt-5.6-luna", "high", "coding")).toEqual({
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
    });
  });

  test("rejects an effort that the selected model does not support", () => {
    expect(() => validateCodexSelection(catalog, "gpt-6-astra", "none", "review"))
      .toThrow('Codex review reasoning effort "none" is not supported for model "gpt-6-astra"');
  });

  test("rejects models outside the enabled catalog", () => {
    expect(() => validateCodexSelection(catalog, "gpt-5.6-unknown", "max", "coding"))
      .toThrow('Codex coding model "gpt-5.6-unknown" is not enabled');
  });
});

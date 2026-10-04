import { describe, expect, test } from "bun:test";
import {
  validateCodexConfig,
  validateCodexSelection,
  type CodexGenerationOptions,
} from "../src/core/codex-catalog.ts";

const catalog: CodexGenerationOptions = {
  models: [
    {
      slug: "gpt-6.1-sol",
      label: "GPT-6.1 Sol",
      description: "GPT-6.1 Sol Codex model.",
      defaultReasoningEffort: "medium",
      reasoningEfforts: [
        { slug: "none", label: "None", isDefault: false },
        { slug: "high", label: "High", isDefault: false },
        { slug: "medium", label: "Medium", isDefault: true },
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
    expect(validateCodexSelection(catalog, "gpt-6.1-sol", "medium", "coding")).toEqual({
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
    });
  });

  test("rejects an effort that the selected model does not support", () => {
    expect(() => validateCodexSelection(catalog, "gpt-6-astra", "none", "review"))
      .toThrow('Codex review reasoning effort "none" is not supported for model "gpt-6-astra"');
  });

  test("rejects models outside the enabled catalog", () => {
    for (const model of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-sol"]) {
      expect(() => validateCodexSelection(catalog, model, "medium", "coding"))
        .toThrow(`Codex coding model "${model}" is not enabled`);
    }
  });
});

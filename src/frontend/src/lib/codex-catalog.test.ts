import { describe, expect, test } from "bun:test";
import { reasoningEffortForModel, type CodexCatalog } from "./codex-catalog";

const catalog: CodexCatalog = {
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

describe("Codex Settings selectors", () => {
  test("preserves a reasoning effort supported by the new model", () => {
    expect(reasoningEffortForModel(catalog, "gpt-6.1-sol", "high")).toBe("high");
  });

  test("switches to the selected model default when the effort is unsupported", () => {
    expect(reasoningEffortForModel(catalog, "gpt-6-astra", "none")).toBe("max");
    expect(reasoningEffortForModel(catalog, "gpt-6.1-sol", "invalid")).toBe("medium");
  });
});

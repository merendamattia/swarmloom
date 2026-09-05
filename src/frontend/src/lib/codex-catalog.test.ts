import { describe, expect, test } from "bun:test";
import { reasoningEffortForModel, type CodexCatalog } from "./codex-catalog";

const catalog: CodexCatalog = {
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

describe("Codex Settings selectors", () => {
  test("preserves a reasoning effort supported by the new model", () => {
    expect(reasoningEffortForModel(catalog, "gpt-5.6-luna", "high")).toBe("high");
  });

  test("switches to the selected model default when the effort is unsupported", () => {
    expect(reasoningEffortForModel(catalog, "gpt-6-astra", "none")).toBe("max");
  });
});

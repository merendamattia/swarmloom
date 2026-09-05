import { codexCatalogRepository } from "../repositories/codex-catalog.ts";
import type { Config } from "./config-schema.ts";

export type CodexReasoningEffortOption = {
  slug: string;
  label: string;
  isDefault: boolean;
};

export type CodexModelOption = {
  slug: string;
  label: string;
  description: string;
  defaultReasoningEffort: string;
  reasoningEfforts: CodexReasoningEffortOption[];
};

export type CodexGenerationOptions = { models: CodexModelOption[] };

export class CodexCatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCatalogValidationError";
  }
}

export async function generationOptions(): Promise<CodexGenerationOptions> {
  const models = await codexCatalogRepository.listEnabled();
  return {
    models: models.map((model) => ({
      slug: model.slug,
      label: model.label,
      description: model.description,
      defaultReasoningEffort: model.defaultReasoningEffort,
      reasoningEfforts: [...model.efforts]
        .sort((left, right) => left.reasoningEffort.sortOrder - right.reasoningEffort.sortOrder)
        .map(({ reasoningEffort, isDefault }) => ({
          slug: reasoningEffort.slug,
          label: reasoningEffort.label,
          isDefault,
        })),
    })),
  };
}

export function validateCodexSelection(
  options: CodexGenerationOptions,
  model: string,
  reasoningEffort: string,
  profile: "coding" | "review",
) {
  const selectedModel = options.models.find((option) => option.slug === model);
  if (!selectedModel) {
    throw new CodexCatalogValidationError(`Codex ${profile} model "${model}" is not enabled`);
  }
  if (!selectedModel.reasoningEfforts.some((option) => option.slug === reasoningEffort)) {
    throw new CodexCatalogValidationError(
      `Codex ${profile} reasoning effort "${reasoningEffort}" is not supported for model "${model}"`,
    );
  }
  return { model, reasoningEffort };
}

export async function validateCodexConfig(config: Pick<Config,
  "AGENT_PROVIDER" | "CODEX_CODING_MODEL" | "CODEX_REVIEW_MODEL" | "CODEX_CODING_REASONING_EFFORT" | "CODEX_REVIEW_REASONING_EFFORT"
>) {
  if (config.AGENT_PROVIDER !== "codex") return;
  const options = await generationOptions();
  validateCodexSelection(options, config.CODEX_CODING_MODEL, config.CODEX_CODING_REASONING_EFFORT, "coding");
  validateCodexSelection(options, config.CODEX_REVIEW_MODEL, config.CODEX_REVIEW_REASONING_EFFORT, "review");
  return options;
}

import { CodexProvider } from "./codex.ts";
import { OpenCodeProvider } from "./opencode.ts";
import type { AgentProvider, ProviderUsageCapability } from "./types.ts";
import type { Config } from "../core/config-schema.ts";

export function createAgentProvider(name: "codex" | "opencode", usage?: ProviderUsageCapability): AgentProvider {
  return name === "codex" ? new CodexProvider(usage) : new OpenCodeProvider();
}

export type AgentProfile = "coding" | "review";
export type AgentJobType = "IMPLEMENTATION" | "FIX" | "REVIEW" | "DECOMPOSITION";

const profileByJobType: Record<AgentJobType, AgentProfile> = {
  IMPLEMENTATION: "coding",
  FIX: "coding",
  REVIEW: "review",
  DECOMPOSITION: "coding",
};

export function agentProfileForJobType(jobType: AgentJobType) {
  return profileByJobType[jobType];
}

export function configuredAgent(config: Config, profile: AgentProfile) {
  return config.AGENT_PROVIDER === "codex" ? {
    provider: "CODEX" as const,
    model: profile === "coding" ? config.CODEX_CODING_MODEL : config.CODEX_REVIEW_MODEL,
    reasoningEffort: profile === "coding"
      ? config.CODEX_CODING_REASONING_EFFORT
      : config.CODEX_REVIEW_REASONING_EFFORT,
  } : {
    provider: "OPENCODE" as const,
    model: profile === "coding" ? config.OPENCODE_CODING_MODEL : config.OPENCODE_REVIEW_MODEL,
    reasoningEffort: undefined,
  };
}

export type {
  AgentEvent,
  AgentProvider,
  AgentRequest,
  AgentResult,
  AgentRole,
  AgentTokenUsage,
  NormalizedProviderEvent,
  ProviderQuotaWindow,
  ProviderUsageAvailability,
  ProviderUsageCapability,
  ProviderUsageSnapshot,
} from "./types.ts";

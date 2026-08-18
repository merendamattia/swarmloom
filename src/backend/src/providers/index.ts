import { CodexProvider } from "./codex.ts";
import { OpenCodeProvider } from "./opencode.ts";
import type { AgentProvider } from "./types.ts";
import type { Config } from "../core/config-schema.ts";

export function createAgentProvider(name: "codex" | "opencode"): AgentProvider {
  return name === "codex" ? new CodexProvider() : new OpenCodeProvider();
}

export function configuredAgent(config: Config) {
  return config.AGENT_PROVIDER === "codex" ? {
    provider: "CODEX" as const,
    model: config.CODEX_MODEL,
    reasoningEffort: config.CODEX_REASONING_EFFORT,
  } : {
    provider: "OPENCODE" as const,
    model: config.OPENCODE_MODEL,
    reasoningEffort: undefined,
  };
}

export type { AgentProvider, AgentRequest, AgentResult, AgentEvent, AgentRole } from "./types.ts";

export type AgentProvider = "codex" | "opencode";

export function providerLoginCommand(provider: AgentProvider) {
  return provider === "codex" ? "codex login --device-auth" : "opencode auth login";
}

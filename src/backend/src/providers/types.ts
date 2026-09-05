export type AgentRole = "issue-worker" | "decomposer" | "reviewer";

export type AgentEventType =
  | "SESSION_STARTED"
  | "AGENT_OUTPUT"
  | "TOOL_STARTED"
  | "TOOL_COMPLETED"
  | "SESSION_COMPLETED"
  | "SESSION_FAILED";

export type AgentEvent = {
  type: AgentEventType;
  timestamp: string;
  message?: string;
  tool?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type ProviderQuotaWindow = {
  limitId: string | null;
  limitName: string | null;
  windowType: "primary" | "secondary";
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: string | null;
};

export type ProviderUsageSnapshot = {
  status: "available" | "unavailable" | "unsupported" | "stale";
  availability?: "available" | "exhausted" | "unknown";
  observedAt: string | null;
  windows: ProviderQuotaWindow[];
  message?: string;
};

export type ProviderFailure = {
  reason: "QUOTA_EXHAUSTED";
  message: string;
  quota: ProviderUsageSnapshot;
};

export interface ProviderUsageCapability {
  readAccountUsage(): Promise<ProviderUsageSnapshot>;
  refreshAccountUsage?(): Promise<ProviderUsageSnapshot>;
}

export type AgentRequest = {
  role: AgentRole;
  workingDirectory: string;
  task: string;
  context: string;
  instructions?: string;
  model: string;
  reasoningEffort?: string;
  resumeSessionId?: string;
  environment?: Record<string, string | undefined>;
  responseFilePath?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
};

export type AgentResult = {
  provider: "codex" | "opencode";
  sessionId: string | null;
  exitCode: number;
  finalOutput: string;
  stderr: string;
  failure?: ProviderFailure;
};

export type NormalizedProviderEvent = {
  event?: AgentEvent;
  sessionId?: string;
  output?: string;
};

export interface AgentProvider {
  readonly name: "codex" | "opencode";
  execute(request: AgentRequest): Promise<AgentResult>;
  readonly usage?: ProviderUsageCapability;
}

export function buildAgentPrompt(request: AgentRequest) {
  return [
    request.instructions && `Instructions:\n${request.instructions}`,
    `Role: ${request.role}`,
    `Task:\n${request.task}`,
    `Context:\n${request.context}`,
    request.resumeSessionId && `Recovery: Resume the existing provider session ${request.resumeSessionId} in the current workspace. Continue from the existing filesystem progress; do not repeat completed inspection or discard prior changes.`,
    request.responseFilePath && `Response file: ${request.responseFilePath}`,
  ].filter(Boolean).join("\n\n");
}

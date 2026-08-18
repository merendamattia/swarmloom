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

export type AgentRequest = {
  role: AgentRole;
  workingDirectory: string;
  task: string;
  context: string;
  instructions?: string;
  artifacts?: Record<string, string>;
  model: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  outputSchemaPath?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
};

export type AgentResult = {
  provider: "codex" | "opencode";
  sessionId: string | null;
  exitCode: number;
  finalOutput: string;
  stderr: string;
};

export type NormalizedProviderEvent = {
  event?: AgentEvent;
  sessionId?: string;
  output?: string;
};

export interface AgentProvider {
  readonly name: "codex" | "opencode";
  execute(request: AgentRequest): Promise<AgentResult>;
}

export function buildAgentPrompt(request: AgentRequest) {
  const artifacts = Object.entries(request.artifacts ?? {})
    .map(([name, value]) => `## ${name}\n${value}`)
    .join("\n\n");
  return [
    request.instructions && `Instructions:\n${request.instructions}`,
    `Role: ${request.role}`,
    `Task:\n${request.task}`,
    `Context:\n${request.context}`,
    artifacts && `Artifacts:\n${artifacts}`,
  ].filter(Boolean).join("\n\n");
}

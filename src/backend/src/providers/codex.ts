import { redactSecrets } from "../core/secrets.ts";
import { runJsonlProcess } from "./process.ts";
import {
  buildAgentPrompt,
  type AgentProvider,
  type AgentRequest,
  type NormalizedProviderEvent,
} from "./types.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function event(type: NonNullable<NormalizedProviderEvent["event"]>["type"], fields = {}) {
  return { type, timestamp: new Date().toISOString(), ...fields };
}

export function buildCodexCommand(request: AgentRequest) {
  const command = [
    "codex", "exec", "--json", "--ignore-user-config", "--model", request.model,
    "--approve-for-me",
  ];
  if (request.reasoningEffort) {
    command.push("--config", `model_reasoning_effort=\"${request.reasoningEffort}\"`);
  }
  command.push("--cd", request.workingDirectory);
  command.push("-");
  return command;
}

export function normalizeCodexEvent(value: unknown): NormalizedProviderEvent {
  const raw = record(value);
  if (!raw || typeof raw.type !== "string") return {};
  if (raw.type === "thread.started" && typeof raw.thread_id === "string") {
    return {
      sessionId: raw.thread_id,
      event: event("SESSION_STARTED", { metadata: { sessionId: raw.thread_id } }),
    };
  }
  const item = record(raw.item);
  if (raw.type === "item.completed" && item?.type === "agent_message") {
    const text = typeof item.text === "string" ? item.text : "";
    return { output: text, event: event("AGENT_OUTPUT", { message: text }) };
  }
  if ((raw.type === "item.started" || raw.type === "item.completed") && item) {
    const tool = typeof item.type === "string" ? item.type : "tool";
    const message = typeof item.command === "string" ? item.command : undefined;
    return {
      event: event(raw.type === "item.started" ? "TOOL_STARTED" : "TOOL_COMPLETED", {
        tool,
        message,
        metadata: typeof item.id === "string" ? { itemId: item.id } : undefined,
      }),
    };
  }
  if (raw.type === "turn.completed") return { event: event("SESSION_COMPLETED") };
  if (raw.type === "turn.failed" || raw.type === "error") {
    const error = record(raw.error);
    const data = record(error?.data);
    const message = typeof raw.message === "string"
      ? raw.message
      : typeof error?.message === "string" ? error.message
      : typeof data?.message === "string" ? data.message
      : "Codex session failed";
    return { event: event("SESSION_FAILED", { message }) };
  }
  return {};
}

export class CodexProvider implements AgentProvider {
  readonly name = "codex" as const;

  async execute(request: AgentRequest) {
    let sessionId: string | null = null;
    let sessionError: string | undefined;
    const output: string[] = [];
    const result = await runJsonlProcess(
      buildCodexCommand(request),
      buildAgentPrompt(request),
      request.signal,
      async (raw) => {
        const normalized = normalizeCodexEvent(raw);
        if (normalized.sessionId) sessionId = normalized.sessionId;
        if (normalized.output) output.push(redactSecrets(normalized.output));
        if (normalized.event) {
          if (normalized.event.type === "SESSION_FAILED") sessionError = normalized.event.message;
          await request.onEvent?.({
            ...normalized.event,
            message: normalized.event.message && redactSecrets(normalized.event.message),
          });
        }
      },
    );
    if (result.exitCode !== 0 && !sessionError) {
      await request.onEvent?.(event("SESSION_FAILED", { message: result.stderr || "Codex exited unsuccessfully" }));
    }
    return {
      provider: this.name,
      sessionId,
      finalOutput: output.join("\n"),
      exitCode: result.exitCode !== 0 ? result.exitCode : sessionError ? 1 : 0,
      stderr: sessionError
        ? `${redactSecrets(sessionError)}${result.stderr ? `\n${result.stderr}` : ""}`
        : result.stderr,
    };
  }
}

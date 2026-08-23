import { redactSecrets } from "../core/secrets.ts";
import { providerEnvironment, runJsonlProcess } from "./process.ts";
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

export function buildOpenCodeCommand(request: AgentRequest) {
  return [
    "opencode", "run", "--format", "json", "--model", request.model,
    "--dir", request.workingDirectory, "--title", `Swarmloom: ${request.role}`,
  ];
}

export function openCodeEnvironment(environment: Record<string, string | undefined>) {
  return {
    ...providerEnvironment(environment),
    OPENCODE_PERMISSION: environment.OPENCODE_PERMISSION ?? '{"*":"allow"}',
  };
}

export function normalizeOpenCodeEvent(value: unknown): NormalizedProviderEvent {
  const raw = record(value);
  if (!raw || typeof raw.type !== "string") return {};
  if (raw.type === "step_start") {
    const sessionId = typeof raw.sessionID === "string" ? raw.sessionID : undefined;
    return {
      sessionId,
      event: event("SESSION_STARTED", { metadata: sessionId ? { sessionId } : undefined }),
    };
  }
  const part = record(raw.part);
  if (raw.type === "text" && typeof part?.text === "string") {
    return { output: part.text, event: event("AGENT_OUTPUT", { message: part.text }) };
  }
  if (raw.type === "tool_use" && part) {
    const state = record(part.state);
    const status = typeof state?.status === "string" ? state.status : "pending";
    const completed = status === "completed" || status === "error";
    return {
      event: event(completed ? "TOOL_COMPLETED" : "TOOL_STARTED", {
        tool: typeof part.tool === "string" ? part.tool : "tool",
        metadata: {
          status,
          ...(typeof part.callID === "string" ? { callId: part.callID } : {}),
        },
      }),
    };
  }
  if (raw.type === "step_finish") return { event: event("SESSION_COMPLETED") };
  if (raw.type === "error") {
    const error = record(raw.error);
    const data = record(error?.data);
    const message = typeof raw.message === "string"
      ? raw.message
      : typeof data?.message === "string" ? data.message
      : typeof error?.message === "string" ? error.message
      : "OpenCode session failed";
    return { event: event("SESSION_FAILED", { message }) };
  }
  return {};
}

export class OpenCodeProvider implements AgentProvider {
  readonly name = "opencode" as const;

  async execute(request: AgentRequest) {
    let sessionId: string | null = null;
    let sessionError: string | undefined;
    const output: string[] = [];
    const environment = openCodeEnvironment({ ...globalThis.process.env, ...request.environment });
    const result = await runJsonlProcess(
      buildOpenCodeCommand(request),
      buildAgentPrompt(request),
      request.signal,
      async (raw) => {
        const normalized = normalizeOpenCodeEvent(raw);
        if (normalized.sessionId) sessionId = normalized.sessionId;
        if (normalized.output) output.push(redactSecrets(normalized.output, environment));
        if (normalized.event) {
          if (normalized.event.type === "SESSION_FAILED") sessionError = normalized.event.message;
          await request.onEvent?.({
            ...normalized.event,
            message: normalized.event.message && redactSecrets(normalized.event.message, environment),
          });
        }
      },
      environment,
    );
    if (result.exitCode !== 0 && !sessionError) {
      await request.onEvent?.(event("SESSION_FAILED", { message: result.stderr || "OpenCode exited unsuccessfully" }));
    }
    return {
      provider: this.name,
      sessionId,
      finalOutput: output.join("\n"),
      exitCode: result.exitCode !== 0 ? result.exitCode : sessionError ? 1 : 0,
      stderr: sessionError
        ? `${redactSecrets(sessionError, environment)}${result.stderr ? `\n${result.stderr}` : ""}`
        : result.stderr,
    };
  }
}

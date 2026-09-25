import { redactSecrets } from "../core/secrets.ts";
import { ProviderProcessError, providerEnvironment, runJsonlProcess } from "./process.ts";
import { quotaAdmission } from "./quota.ts";
import {
  normalizeCodexThreadUsage,
  normalizeCodexTokenUsage,
  type CodexUsageReader,
} from "./codex-usage.ts";
import {
  buildAgentPrompt,
  type AgentProvider,
  type AgentRequest,
  type AgentTokenUsage,
  type NormalizedProviderEvent,
  type ProviderUsageSnapshot,
} from "./types.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function event(type: NonNullable<NormalizedProviderEvent["event"]>["type"], fields = {}) {
  return { type, timestamp: new Date().toISOString(), ...fields };
}

export { normalizeCodexTokenUsage } from "./codex-usage.ts";

export function buildCodexCommand(request: AgentRequest) {
  const command = request.resumeSessionId
    ? ["codex", "exec", "resume", request.resumeSessionId, "--json", "--ignore-user-config", "--model", request.model,
      "--dangerously-bypass-approvals-and-sandbox"]
    : ["codex", "exec", "--json", "--ignore-user-config", "--model", request.model,
      "--dangerously-bypass-approvals-and-sandbox"];
  if (request.reasoningEffort) {
    command.push("--config", `model_reasoning_effort=\"${request.reasoningEffort}\"`);
  }
  if (!request.resumeSessionId) command.push("--cd", request.workingDirectory);
  command.push("-");
  return command;
}

export function normalizeCodexEvent(value: unknown): NormalizedProviderEvent {
  const raw = record(value);
  if (!raw) return {};
  if (raw.method === "thread/tokenUsage/updated" || raw.type === "thread/tokenUsage/updated") {
    const usage = normalizeCodexThreadUsage(raw);
    return usage ? { usage } : {};
  }
  if (raw.method === "thread/started") {
    const params = record(raw.params);
    const thread = record(params?.thread);
    const sessionId = typeof thread?.id === "string" ? thread.id : undefined;
    return sessionId
      ? { sessionId, event: event("SESSION_STARTED", { metadata: { sessionId } }) }
      : {};
  }
  if (typeof raw.type !== "string") return {};
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
  if (raw.type === "turn.completed" || raw.type === "turn/completed") {
    const usage = normalizeCodexTokenUsage(raw.usage);
    return {
      ...(usage ? { usage } : {}),
      event: event("SESSION_COMPLETED"),
    };
  }
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

  constructor(readonly usage?: CodexUsageReader) {}

  async execute(request: AgentRequest) {
    let sessionId: string | null = null;
    let sessionError: string | undefined;
    let latestUsage: AgentTokenUsage | undefined;
    const output: string[] = [];
    const environment = providerEnvironment({ ...globalThis.process.env, ...request.environment });
    const resumeMismatch = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, resumeMismatch.signal])
      : resumeMismatch.signal;
    const onJson = async (raw: unknown) => {
      if (isResumeMismatch(sessionError)) return;
      const normalized = normalizeCodexEvent(raw);
      if (normalized.sessionId) {
        if (request.resumeSessionId && normalized.sessionId !== request.resumeSessionId) {
          sessionError = `Codex resumed session mismatch: requested ${request.resumeSessionId}, received ${normalized.sessionId}`;
          try {
            await request.onEvent?.(event("SESSION_FAILED", { message: sessionError }));
          } finally {
            resumeMismatch.abort(new Error(sessionError));
          }
          return;
        }
        sessionId = normalized.sessionId;
      }
      if (normalized.usage) {
        latestUsage = normalized.usage;
        try {
          await request.onUsage?.(normalized.usage);
        } catch {
          // Usage persistence is telemetry and must not fail executable work.
        }
      }
      if (normalized.output) output.push(redactSecrets(normalized.output, environment));
      if (!normalized.event) return;
      if (normalized.event.type === "SESSION_FAILED") sessionError = normalized.event.message;
      await request.onEvent?.({
        ...normalized.event,
        message: normalized.event.message && redactSecrets(normalized.event.message, environment),
      });
    };

    const recoverUsage = async () => {
      if (!sessionId || !this.usage?.readThreadUsage) return;
      try {
        const usage = await this.usage.readThreadUsage(sessionId);
        if (!usage) return;
        latestUsage = usage;
        try {
          await request.onUsage?.(usage);
        } catch {
          // Usage persistence is telemetry and must not fail executable work.
        }
      } catch {
        // App Server usage recovery is best-effort; the exec result remains authoritative.
      }
    };

    let result: { exitCode: number; stderr: string };
    try {
      result = await runJsonlProcess(
        buildCodexCommand(request),
        buildAgentPrompt(request),
        signal,
        onJson,
        environment,
        request.workingDirectory,
      );
    } catch (error) {
      if (!(error instanceof ProviderProcessError)) throw error;
      await recoverUsage();
      const resumeError = request.resumeSessionId && (isResumeMismatch(sessionError) || !sessionId)
        ? resumeIdentityError(request.resumeSessionId, sessionError)
        : undefined;
      if (resumeError) {
        if (resumeError !== sessionError) await request.onEvent?.(event("SESSION_FAILED", { message: resumeError }));
        return this.result(sessionId, output, error.exitCode, error.stderr, resumeError, undefined, environment, latestUsage);
      }
      const quota = await this.readFailureQuota();
      if (!quota || quotaAdmission(quota).kind !== "wait") throw error;
      const message = failureMessage(error.stderr, sessionError) || error.message;
      if (!sessionError) await request.onEvent?.(event("SESSION_FAILED", { message: redactSecrets(message, environment) }));
      return this.result(sessionId, output, error.exitCode, error.stderr, message, quota, environment, latestUsage);
    }

    await recoverUsage();
    const resumeError = request.resumeSessionId && (isResumeMismatch(sessionError) || !sessionId)
      ? resumeIdentityError(request.resumeSessionId, sessionError)
      : undefined;
    if (resumeError) {
      if (resumeError !== sessionError) await request.onEvent?.(event("SESSION_FAILED", { message: resumeError }));
      sessionError = resumeError;
    }
    if (result.exitCode !== 0 && !sessionError) {
      await request.onEvent?.(event("SESSION_FAILED", { message: result.stderr || "Codex exited unsuccessfully" }));
    }
    const exitCode = result.exitCode !== 0 ? result.exitCode : sessionError ? 1 : 0;
    if (exitCode === 0) {
      return this.result(sessionId, output, 0, result.stderr, undefined, undefined, environment, latestUsage);
    }
    if (resumeError) {
      return this.result(sessionId, output, exitCode, result.stderr, resumeError, undefined, environment, latestUsage);
    }
    const quota = await this.readFailureQuota();
    const message = failureMessage(result.stderr, sessionError) || "Codex exited unsuccessfully";
    return this.result(sessionId, output, exitCode, result.stderr, message, quota, environment, latestUsage);
  }

  private async readFailureQuota() {
    if (!this.usage) return undefined;
    try {
      return this.usage.refreshAccountUsage
        ? await this.usage.refreshAccountUsage()
        : await this.usage.readAccountUsage();
    } catch {
      return undefined;
    }
  }

  private result(
    sessionId: string | null,
    output: string[],
    exitCode: number,
    stderr: string,
    message: string | undefined,
    quota: ProviderUsageSnapshot | undefined,
    environment: Record<string, string | undefined>,
    usage: AgentTokenUsage | undefined,
  ) {
    const failure = quota && quotaAdmission(quota).kind === "wait"
      ? { reason: "QUOTA_EXHAUSTED" as const, message: redactSecrets(message ?? "Codex quota exhausted", environment), quota }
      : undefined;
    const safeMessage = message ? redactSecrets(message, environment) : "";
    const safeStderr = stderr ? redactSecrets(stderr, environment) : "";
    const details = safeStderr && !safeMessage.includes(safeStderr)
      ? `${safeMessage}${safeMessage ? "\n" : ""}${safeStderr}`
      : safeMessage || safeStderr;
    return {
      provider: this.name,
      sessionId,
      finalOutput: output.join("\n"),
      exitCode,
      stderr: details,
      ...(usage ? { usage } : {}),
      ...(failure ? { failure } : {}),
    };
  }
}

function failureMessage(...messages: Array<string | undefined>) {
  return [...new Set(messages.filter((message): message is string => Boolean(message)))].join("\n");
}

function resumeIdentityError(requestedSessionId: string, sessionError?: string) {
  if (sessionError?.startsWith("Codex resumed session mismatch:")) return sessionError;
  return `Codex did not resume session ${requestedSessionId}${sessionError ? `: ${sessionError}` : ""}`;
}

function isResumeMismatch(sessionError?: string) {
  return sessionError?.startsWith("Codex resumed session mismatch:") ?? false;
}

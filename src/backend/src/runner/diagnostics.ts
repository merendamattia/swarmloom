import { redactSecrets } from "../core/secrets.ts";
import type { AgentRole } from "../providers/index.ts";

export type DiagnosticStage =
  | "implementation"
  | "decomposition"
  | "review"
  | "provider_process"
  | "parser"
  | "job";

export type DiagnosticEvent = {
  type: string;
  timestamp: string;
  message?: string;
  tool?: string;
};

export type JobDiagnostics = {
  stage: DiagnosticStage;
  role: AgentRole | null;
  provider: string;
  model: string;
  sessionId: string | null;
  exitCode: number | null;
  error: string;
  causeChain: string[];
  stderr?: string;
  finalOutput?: string;
  events: DiagnosticEvent[];
};

export class AgentExecutionError extends Error {
  constructor(
    message: string,
    readonly diagnostics: JobDiagnostics,
  ) {
    super(message);
    this.name = "AgentExecutionError";
  }
}

export function causeChain(
  error: unknown,
  environment: Record<string, string | undefined> = globalThis.process.env,
): string[] {
  const chain: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    const safe = redactSecrets(message, environment).slice(0, 2_000);
    if (safe && !chain.includes(safe)) chain.push(safe);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

export function minimalDiagnostics(
  error: unknown,
  fields: { provider: string; model: string },
  environment: Record<string, string | undefined> = globalThis.process.env,
): JobDiagnostics {
  const message = redactSecrets(error instanceof Error ? error.message : String(error), environment).slice(0, 2_000);
  return {
    stage: "job",
    role: null,
    provider: fields.provider,
    model: fields.model,
    sessionId: null,
    exitCode: null,
    error: message,
    causeChain: causeChain(error, environment),
    events: [],
  };
}

export function tail(text: string, limit: number) {
  return text.length > limit ? `[truncated]\n${text.slice(-limit)}` : text;
}
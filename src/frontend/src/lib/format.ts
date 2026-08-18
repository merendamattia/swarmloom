const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

type TimelineEvent = { type: string; message?: string };

type PullRequestResult = {
  number: number;
  url: string;
  base: string;
  head: string;
};

export type JobResultView =
  | { outcome: "implemented"; summary: string; tests: string[]; commit: string; pr: PullRequestResult }
  | { outcome: "blocked"; summary: string; question: string }
  | { outcome: "requires_decomposition"; summary: string; reason: string }
  | { outcome: "decomposed"; summary: string; childIssues: Array<{ number: number; url: string; ready: boolean }> };

export type ReviewView = {
  verdict: "pass" | "changes_requested";
  summary: string;
  findings: Array<{
    file: string;
    line: number | null;
    severity: "low" | "medium" | "high" | "critical";
    problem: string;
    correction: string;
  }>;
};

export type MarkdownPart = { kind: "text" | "strong" | "code" | "link"; value: string; href?: string };
export type AgentOutputView = { outcome: JobResultView["outcome"] | null; summary: string };

export type DiagnosticsEventView = {
  type: string;
  timestamp: string;
  message: string | null;
  tool: string | null;
};

export type DiagnosticsView = {
  stage: string;
  role: string | null;
  provider: string;
  model: string;
  sessionId: string | null;
  exitCode: number | null;
  error: string;
  causeChain: string[];
  stderr: string | null;
  finalOutput: string | null;
  events: DiagnosticsEventView[];
};

export function agentOutputEvents<T extends TimelineEvent>(events: T[]) {
  return events.filter((event) =>
    (event.type === "AGENT_OUTPUT" || event.type === "AGENT_AGENT_OUTPUT") && event.message?.trim());
}

export function agentOutputMessage(message: string, pullRequestUrl: string | null) {
  if (!pullRequestUrl) return message;
  const number = /\/pull\/(\d+)$/.exec(pullRequestUrl)?.[1];
  if (!number) return message;
  return message.replace(new RegExp(`https://github\\.com/\\[REDACTED\\]/[^/\\s"']+/pull/${number}`, "g"), pullRequestUrl);
}

export function normalizeAgentOutput(message: string): AgentOutputView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  const result = record(parsed);
  const summary = stringValue(result?.summary);
  if (!summary) return null;
  return { summary, outcome: isOutcome(result?.outcome) ? result.outcome : null };
}

export function dateTime(value: string | Date | null | undefined) {
  return value ? dateTimeFormatter.format(new Date(value)) : "Not recorded";
}

export function duration(milliseconds: number | null | undefined) {
  if (milliseconds == null) return "Not recorded";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

export function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function shortCommit(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "Not recorded";
}

export function normalizeJobResult(value: unknown): JobResultView | null {
  const result = record(value);
  const outcome = stringValue(result?.outcome);
  const summary = stringValue(result?.summary);
  if (!result || !outcome || !summary) return null;

  if (outcome === "implemented") {
    const pr = record(result.pr);
    const number = numberValue(pr?.number);
    const url = stringValue(pr?.url);
    const base = stringValue(pr?.base);
    const head = stringValue(pr?.head);
    if (number == null || !url || !base || !head) return null;
    return { outcome, summary, tests: stringList(result.tests), commit: stringValue(result.commit) ?? "Not recorded", pr: { number, url, base, head } };
  }

  if (outcome === "blocked") {
    const question = stringValue(result.question);
    return question ? { outcome, summary, question } : null;
  }

  if (outcome === "requires_decomposition") {
    const reason = stringValue(result.reason);
    return reason ? { outcome, summary, reason } : null;
  }

  if (outcome === "decomposed") {
    const childIssues = Array.isArray(result.childIssues)
      ? result.childIssues.flatMap((value) => {
        const child = record(value);
        const number = numberValue(child?.number);
        const url = stringValue(child?.url);
        return number != null && url && typeof child?.ready === "boolean"
          ? [{ number, url, ready: child.ready }]
          : [];
      })
      : [];
    return { outcome, summary, childIssues };
  }

  return null;
}

export function normalizeReview(verdictValue: unknown, findingsValue: unknown): ReviewView | null {
  const verdict = record(verdictValue);
  const reviewVerdict = verdict?.verdict;
  const summary = stringValue(verdict?.summary);
  if ((reviewVerdict !== "pass" && reviewVerdict !== "changes_requested") || !summary) return null;

  const findings = Array.isArray(findingsValue)
    ? findingsValue.flatMap((value) => {
      const finding = record(value);
      const file = stringValue(finding?.file);
      const severity = finding?.severity;
      const problem = stringValue(finding?.problem);
      const correction = stringValue(finding?.correction);
      if (!file || !problem || !correction || !isSeverity(severity)) return [];
      return [{ file, line: numberValue(finding?.line), severity, problem, correction }];
    })
    : [];

  return { verdict: reviewVerdict, summary, findings };
}

export function normalizeDiagnostics(value: unknown): DiagnosticsView | null {
  const result = record(value);
  const stage = stringValue(result?.stage);
  if (!result || !stage) return null;
  return {
    stage,
    role: nullableString(result.role),
    provider: stringValue(result.provider) ?? "Not recorded",
    model: stringValue(result.model) ?? "Not recorded",
    sessionId: nullableString(result.sessionId),
    exitCode: numberOrNull(result.exitCode),
    error: stringValue(result.error) ?? "No error detail recorded",
    causeChain: stringList(result.causeChain),
    stderr: nullableString(result.stderr),
    finalOutput: nullableString(result.finalOutput),
    events: Array.isArray(result.events)
      ? result.events.flatMap((value) => {
        const event = record(value);
        const type = stringValue(event?.type);
        return type
          ? [{ type, timestamp: stringValue(event?.timestamp) ?? "", message: nullableString(event?.message), tool: nullableString(event?.tool) }]
          : [];
      })
      : [],
  };
}

export function diagnosticsBundle(view: DiagnosticsView) {
  return [
    "Swarmloom job diagnostics",
    `Stage: ${statusLabel(view.stage)}`,
    `Role: ${view.role ?? "Not recorded"}`,
    `Provider: ${view.provider}`,
    `Model: ${view.model}`,
    `Session: ${view.sessionId ?? "Not recorded"}`,
    `Exit code: ${view.exitCode ?? "Not recorded"}`,
    "",
    "Error:",
    view.error,
    ...(view.causeChain.length ? ["", "Cause chain:", ...view.causeChain.map((cause) => `- ${cause}`)] : []),
    "",
    `Stderr: ${view.stderr ?? "Not recorded"}`,
    "",
    `Final provider output: ${view.finalOutput ?? "Not recorded"}`,
    "",
    "Agent/tool timeline:",
    ...(view.events.length
      ? view.events.map((event) => `[${event.timestamp}] ${event.type}${event.tool ? ` (${event.tool})` : ""}${event.message ? `: ${event.message}` : ""}`)
      : ["No agent or tool events were recorded."]),
  ].join("\n");
}

export function inlineMarkdown(value: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const token = match[0];
    const index = match.index ?? cursor;
    if (index > cursor) parts.push({ kind: "text", value: value.slice(cursor, index) });
    if (token.startsWith("**")) {
      parts.push({ kind: "strong", value: token.slice(2, -2) });
    } else if (token.startsWith("`")) {
      parts.push({ kind: "code", value: token.slice(1, -1) });
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      parts.push(link ? { kind: "link", value: link[1], href: link[2] } : { kind: "text", value: token });
    }
    cursor = index + token.length;
  }
  if (cursor < value.length) parts.push({ kind: "text", value: value.slice(cursor) });
  return parts.length ? parts : [{ kind: "text", value }];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" && item.trim() ? [item] : []) : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function isSeverity(value: unknown): value is ReviewView["findings"][number]["severity"] {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function isOutcome(value: unknown): value is JobResultView["outcome"] {
  return value === "implemented" || value === "blocked" || value === "requires_decomposition" || value === "decomposed";
}

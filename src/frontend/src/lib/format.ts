const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

type TimelineEvent = { type: string; message?: string };

export type MarkdownPart = { kind: "text" | "strong" | "code" | "link"; value: string; href?: string };

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

export function triggerLabel(value: string | null | undefined) {
  if (!value) return null;
  if (value === "REVIEW_CHANGES_REQUESTED") return "reviewer feedback";
  if (value === "PR_FIX_REQUESTED") return "fix requested";
  if (value === "ISSUE_READY") return "issue ready";
  return statusLabel(value);
}

export function subjectLabel(subjectType: string, issueNumber: number, pullRequestNumber: number | null) {
  return subjectType === "PULL_REQUEST" ? `PR #${pullRequestNumber ?? "?"}` : `Issue #${issueNumber}`;
}

export function shortCommit(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "Not recorded";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableString(value: unknown) {
  return stringValue(value);
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.flatMap((entry) => stringValue(entry) ?? []) : [];
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

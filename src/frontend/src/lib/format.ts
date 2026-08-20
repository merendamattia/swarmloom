const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

type TimelineEvent = { type: string; message?: string };

export type MarkdownPart = { kind: "text" | "strong" | "code" | "link"; value: string; href?: string };

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

import { redactSecrets } from "../core/secrets.ts";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type TelegramOptions = {
  token: string;
  chatId: string;
  dashboardUrl?: string;
  fetch?: Fetch;
};

type TelegramEvent = {
  type: string;
  message: string;
  id: string;
  jobId?: string | null;
  metadata?: unknown;
};

type QueuedJob = {
  repository: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl?: string | null;
  jobId?: string | null;
  jobType?: string | null;
  pullRequestNumber?: number | null;
};

export type TelegramQueueSummary = {
  scanRunId?: string | null;
  jobs: QueuedJob[];
};

const eventTitles: Record<string, [string, string]> = {
  SCAN_FAILED: ["🚨", "Scan failed"],
  JOB_STARTED: ["🚀", "Job started"],
  JOB_COMPLETED: ["✅", "Job completed"],
  JOB_FAILED: ["❌", "Job failed"],
  JOB_BLOCKED: ["⛔", "Job blocked"],
  JOB_DECOMPOSED: ["🧩", "Job decomposed"],
  JOB_CANCELLED: ["🛑", "Job cancelled"],
  JOB_RETRY_REQUESTED: ["🔁", "Job retry requested"],
  PR_OPENED: ["🔗", "Pull request opened"],
  PR_REVIEW_REQUESTED: ["🧪", "Review requested"],
  PR_FIX_REQUESTED: ["🛠️", "Fix requested"],
  REVIEW_COMPLETED: ["🧪", "Review completed"],
  REVIEW_PASSED: ["🎉", "Review passed"],
  READY_TO_MERGE: ["🎉", "Review passed · Ready to merge"],
  PR_MERGED: ["🎊", "Pull request merged"],
  ISSUE_DONE: ["✅", "Issue done"],
  LOOP_GUARD_TRIPPED: ["🛑", "Automatic fix limit reached"],
  REPOSITORY_INVALID: ["⚠️", "Repository invalid"],
  REPOSITORY_ERROR: ["⚠️", "Repository error"],
  GITHUB_RECONCILIATION_REQUIRED: ["⚠️", "GitHub reconciliation required"],
  TELEGRAM_TEST: ["📨", "Telegram test"],
};

export function createTelegramNotifier(options: TelegramOptions) {
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    async send(event: TelegramEvent) {
      await sendText(formatTelegramEvent(event, options.dashboardUrl));
    },
    async sendQueued(summary: TelegramQueueSummary) {
      await sendText(formatTelegramQueueSummary(summary));
    },
  };

  async function sendText(text: string) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${options.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: options.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (!response.ok) {
        throw new Error(`Telegram request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redactSecrets(message, { TELEGRAM_BOT_TOKEN: options.token }));
    }
  }
}

export function formatTelegramEvent(event: TelegramEvent, dashboardUrl?: string) {
  const [emoji, title] = eventTitles[event.type] ?? ["ℹ️", event.type];
  const metadata = isRecord(event.metadata) ? event.metadata : {};
  const links = [
    link(metadata.issueUrl, "Issue"),
    link(metadata.pullRequestUrl, "Pull request"),
    dashboardLink(dashboardUrl, event.jobId),
  ].filter(Boolean);
  const detail = typeof metadata.tldr === "string" && metadata.tldr.trim()
    ? metadata.tldr.trim()
    : event.message;
  const pullRequest = pullRequestDetails(metadata);
  const suffix = [
    pullRequest ? `\n${pullRequest}` : "",
    links.length ? `\n🔗 ${links.join(" · ")}` : "",
  ].filter(Boolean).join("");
  const heading = `${emoji} <b>${escapeHtml(title)}</b>`;
  const detailLimit = Math.min(3_200, Math.max(0, MAX_TELEGRAM_LENGTH - heading.length - suffix.length - 1));
  const message = escapeHtmlWithLimit(detail, detailLimit);
  return [
    heading,
    message,
    suffix,
  ].filter(Boolean).join("\n");
}

const MAX_TELEGRAM_LENGTH = 4_000;

export function formatTelegramQueueSummary(summary: TelegramQueueSummary) {
  const lines = [
    `📥 <b>Scan queued ${summary.jobs.length} job${summary.jobs.length === 1 ? "" : "s"}</b>`,
    ...summary.jobs.map(queuedJobLine),
  ];
  return joinWithinLimit(lines, MAX_TELEGRAM_LENGTH);
}

function queuedJobLine(job: QueuedJob) {
  const kind = job.jobType ? `<b>${escapeHtml(job.jobType)}</b> · ` : "";
  const subject = job.pullRequestNumber != null
    ? `PR #${job.pullRequestNumber}`
    : `issue #${job.issueNumber}`;
  const description = `<b>${escapeHtml(`${job.repository}#${job.issueNumber}`)}</b> · ${kind}${escapeHtmlWithLimit(job.issueTitle, 200)}`;
  const issueLink = link(job.issueUrl, subject);
  return issueLink ? `${description}\n🔗 ${issueLink}` : description;
}

function joinWithinLimit(lines: string[], max: number) {
  let text = "";
  for (let i = 0; i < lines.length; i++) {
    const candidate = text ? `${text}\n${lines[i]}` : lines[i];
    const dropped = lines.length - i;
    const suffix = dropped > 0 ? `\n… and ${dropped} more job${dropped === 1 ? "" : "s"}` : "";
    if (candidate.length + suffix.length > max) {
      return text ? `${text}${suffix}` : candidate.slice(0, max);
    }
    text = candidate;
  }
  return text;
}

function pullRequestDetails(metadata: Record<string, unknown>) {
  const title = metadata.pullRequestTitle;
  if (typeof title !== "string" || !title.trim()) return null;
  const number = metadata.pullRequestNumber;
  const lines = [
    `<b>PR${typeof number === "number" ? ` #${number}` : ""}:</b> ${escapeHtmlWithLimit(title, 200)}`,
  ];
  const stats = pullRequestStats(metadata);
  if (stats) lines.push(stats);
  return lines.join("\n");
}

function pullRequestStats(metadata: Record<string, unknown>) {
  const parts: string[] = [];
  if (typeof metadata.additions === "number") parts.push(`+${metadata.additions}`);
  if (typeof metadata.deletions === "number") parts.push(`-${metadata.deletions}`);
  if (typeof metadata.filesChanged === "number") {
    parts.push(`${metadata.filesChanged} file${metadata.filesChanged === 1 ? "" : "s"}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

function dashboardLink(baseUrl: string | undefined, jobId: string | null | undefined) {
  if (!baseUrl) return null;
  try {
    const url = new URL(jobId ? `/jobs/${encodeURIComponent(jobId)}` : "/", baseUrl);
    return `<a href="${escapeHtml(url.href)}">Dashboard</a>`;
  } catch {
    return null;
  }
}

function link(value: unknown, label: string) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!(["http:", "https:"].includes(url.protocol))) return null;
    return `<a href="${escapeHtml(url.href)}">${label}</a>`;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtmlWithLimit(value: string, max: number) {
  if (max <= 0) return "";
  let escaped = "";
  for (const character of value) {
    const next = escapeHtml(character);
    if (escaped.length + next.length > max) return escaped.length < max ? `${escaped}…` : escaped;
    escaped += next;
  }
  return escaped;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

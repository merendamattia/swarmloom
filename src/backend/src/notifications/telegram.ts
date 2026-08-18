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

const eventTitles: Record<string, [string, string]> = {
  SCAN_STARTED: ["🔎", "Scan started"],
  SCAN_DISCOVERY_COMPLETED: ["📋", "Scan discovery completed"],
  SCAN_COMPLETED: ["✅", "Scan completed"],
  SCAN_FAILED: ["🚨", "Scan failed"],
  JOB_QUEUED: ["📥", "Job queued"],
  JOB_STARTED: ["🚀", "Job started"],
  JOB_COMPLETED: ["✅", "Job completed"],
  JOB_FAILED: ["❌", "Job failed"],
  JOB_BLOCKED: ["⛔", "Job blocked"],
  JOB_DECOMPOSED: ["🧩", "Job decomposed"],
  JOB_CANCELLED: ["🛑", "Job cancelled"],
  JOB_RETRY_REQUESTED: ["🔁", "Job retry requested"],
  PR_OPENED: ["🔗", "Pull request opened"],
  REVIEW_COMPLETED: ["🧪", "Review completed"],
  REPOSITORY_INVALID: ["⚠️", "Repository invalid"],
  REPOSITORY_ERROR: ["⚠️", "Repository error"],
  GITHUB_RECONCILIATION_REQUIRED: ["⚠️", "GitHub reconciliation required"],
  TELEGRAM_TEST: ["📨", "Telegram test"],
};

export function createTelegramNotifier(options: TelegramOptions) {
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    async send(event: TelegramEvent) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${options.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: options.chatId,
            text: formatTelegramEvent(event, options.dashboardUrl),
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
    },
  };
}

export function formatTelegramEvent(event: TelegramEvent, dashboardUrl?: string) {
  const [emoji, title] = eventTitles[event.type] ?? ["ℹ️", event.type];
  const metadata = isRecord(event.metadata) ? event.metadata : {};
  const links = [
    link(metadata.issueUrl, "Issue"),
    link(metadata.pullRequestUrl, "Pull request"),
    dashboardLink(dashboardUrl, event.jobId),
  ].filter(Boolean);
  const message = escapeHtmlWithLimit(event.message, 3_200);
  return [
    `${emoji} <b>${escapeHtml(title)}</b>`,
    message,
    links.length ? `\n🔗 ${links.join(" · ")}` : "",
  ].filter(Boolean).join("\n");
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
  let escaped = "";
  for (const character of value) {
    const next = escapeHtml(character);
    if (escaped.length + next.length > max) return `${escaped}…`;
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

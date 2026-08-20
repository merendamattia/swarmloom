import type { Config } from "../core/config-schema.ts";
import { redactSecrets } from "../core/secrets.ts";

type DiagnosticRecord = Record<string, unknown>;

type SupportIssueJob = {
  id: string;
  repository: { fullName: string };
  issueNumber: number;
  issueUrl: string;
  jobType: string;
  subjectType: string;
  pullRequestUrl: string | null;
  provider: string;
  model: string;
  exitCode: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  errorMessage: string | null;
  diagnostics: unknown;
};

function environment(config: Config) {
  return { ...globalThis.process.env, GITHUB_TOKEN: config.GITHUB_TOKEN };
}

function safe(value: unknown, secrets: Record<string, string | undefined>, limit = 12_000) {
  return redactSecrets(String(value ?? "Not recorded"), secrets).slice(0, limit);
}

function record(value: unknown): DiagnosticRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as DiagnosticRecord
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.flatMap((entry) => stringValue(entry) ?? []) : [];
}

function eventLines(value: unknown, secrets: Record<string, string | undefined>) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const event = record(entry);
    const type = stringValue(event?.type);
    if (!type) return [];
    const timestamp = stringValue(event?.timestamp) ?? "No timestamp";
    const tool = stringValue(event?.tool);
    const message = stringValue(event?.message);
    return [`[${safe(timestamp, secrets)}] ${safe(type, secrets)}${tool ? ` (${safe(tool, secrets)})` : ""}${message ? `: ${safe(message, secrets)}` : ""}`];
  });
}

function timestamp(value: Date | null) {
  return value?.toISOString() ?? "Not recorded";
}

export function supportIssueTitle(job: Pick<SupportIssueJob, "repository" | "issueNumber" | "errorMessage">, config: Config) {
  const secrets = environment(config);
  const summary = job.errorMessage ? safe(job.errorMessage, secrets, 160).replace(/\s+/g, " ").trim() : "";
  const title = summary || "Failed job";
  return `[Swarmloom] ${title.slice(0, 120)} (${safe(job.repository.fullName, secrets)}#${job.issueNumber})`;
}

export function supportIssueBody(job: SupportIssueJob, config: Config) {
  const secrets = environment(config);
  const diagnostics = record(job.diagnostics);
  const error = safe(job.errorMessage ?? diagnostics?.error ?? "No error summary recorded", secrets, 2_000);
  const details = [
    diagnostics?.error ? `Error: ${safe(diagnostics.error, secrets)}` : undefined,
    ...stringList(diagnostics?.causeChain).map((cause) => `Cause: ${safe(cause, secrets)}`),
    diagnostics?.stderr ? `Stderr:
${safe(diagnostics.stderr, secrets)}` : undefined,
    diagnostics?.finalOutput ? `Final provider output:
${safe(diagnostics.finalOutput, secrets)}` : undefined,
  ].filter((line): line is string => line !== undefined);
  const jobUrl = `${config.FRONTEND_URL.replace(/\/$/, "")}/jobs/${encodeURIComponent(job.id)}`;
  const events = eventLines(diagnostics?.events, secrets);
  const metadata = [
    `- Failed stage: ${safe(diagnostics?.stage, secrets)}`,
    `- Role: ${safe(diagnostics?.role, secrets)}`,
    `- Provider: ${safe(job.provider, secrets)}`,
    `- Model: ${safe(job.model, secrets)}`,
    `- Session: ${safe(diagnostics?.sessionId, secrets)}`,
    `- Exit code: ${diagnostics?.exitCode ?? job.exitCode ?? "Not recorded"}`,
    `- Started: ${timestamp(job.startedAt)}`,
    `- Failed: ${timestamp(job.completedAt ?? job.updatedAt)}`,
  ];

  return [
    "## Swarmloom job failure",
    "",
    `- Repository: \`${safe(job.repository.fullName, secrets)}\``,
    `- Job ID: \`${safe(job.id, secrets)}\``,
    `- Swarmloom job: ${jobUrl}`,
    `- Job type: ${safe(job.jobType, secrets)}`,
    `- Subject: ${safe(job.subjectType, secrets)} #${job.issueNumber} (${safe(job.issueUrl, secrets)})`,
    job.pullRequestUrl ? `- Pull request: ${safe(job.pullRequestUrl, secrets)}` : undefined,
    `- Failure timestamp: ${timestamp(job.completedAt ?? job.updatedAt)}`,
    "",
    "### Error summary",
    error,
    "",
    "### Error details and stack trace",
    "```text",
    details.length ? details.join("\n\n") : error,
    "```",
    "",
    "### Execution metadata",
    ...metadata,
    ...(events.length ? ["", "### Agent/tool timeline", ...events.map((event) => `- ${event}`)] : []),
    "",
    "This issue was created manually from the Swarmloom failed-job view.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

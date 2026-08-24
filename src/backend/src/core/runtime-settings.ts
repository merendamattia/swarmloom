import { CronPattern } from "croner";
import { z } from "zod";
import type { Config } from "./config-schema.ts";
import { parseConfig } from "./config-schema.ts";

const runtimeSettingSchema = z.object({
  githubRepositories: z.string().min(1).optional(),
  issueReadyLabel: z.string().min(1).optional(),
  issueWorkingLabel: z.string().min(1).optional(),
  issueBlockedLabel: z.string().min(1).optional(),
  issueCompletedLabel: z.string().min(1).optional(),
  issueDecomposedLabel: z.string().min(1).optional(),
  issueReadyToMergeLabel: z.string().min(1).optional(),
  issueHumanReviewLabel: z.string().min(1).optional(),
  prReviewRequestedLabel: z.string().min(1).optional(),
  prFixRequestedLabel: z.string().min(1).optional(),
  prReviewPassedLabel: z.string().min(1).optional(),
  maxAutomaticFixCycles: z.coerce.number().int().min(1).max(50).optional(),
  createDiagnosticIssues: z.boolean().optional(),
  scheduleCron: z.string().refine(isCron, "Invalid five-part cron expression").optional(),
  scheduleTimezone: z.string().min(1).optional(),
  maxParallelJobs: z.coerce.number().int().min(1).max(20).optional(),
  agentProvider: z.enum(["codex", "opencode"]).optional(),
  opencodeCodingModel: z.string().min(1).optional(),
  opencodeReviewModel: z.string().min(1).optional(),
  codexCodingModel: z.string().min(1).optional(),
  codexReviewModel: z.string().min(1).optional(),
  codexCodingReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  codexReviewReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  telegramEnabled: z.boolean().optional(),
  telegramBotToken: z.string().min(1).optional(),
  telegramChatId: z.string().min(1).optional(),
  heartbeatIntervalMs: z.coerce.number().int().min(1_000).optional(),
  staleJobThresholdMs: z.coerce.number().int().min(5_000).optional(),
  agentTimeoutMs: z.coerce.number().int().min(60_000).optional(),
}).strict();

const runtimeToEnvironment = {
  githubRepositories: "GITHUB_REPOSITORIES",
  issueReadyLabel: "ISSUE_READY_LABEL",
  issueWorkingLabel: "ISSUE_WORKING_LABEL",
  issueBlockedLabel: "ISSUE_BLOCKED_LABEL",
  issueCompletedLabel: "ISSUE_COMPLETED_LABEL",
  issueDecomposedLabel: "ISSUE_DECOMPOSED_LABEL",
  issueReadyToMergeLabel: "ISSUE_READY_TO_MERGE_LABEL",
  issueHumanReviewLabel: "ISSUE_HUMAN_REVIEW_LABEL",
  prReviewRequestedLabel: "PR_REVIEW_REQUESTED_LABEL",
  prFixRequestedLabel: "PR_FIX_REQUESTED_LABEL",
  prReviewPassedLabel: "PR_REVIEW_PASSED_LABEL",
  maxAutomaticFixCycles: "MAX_AUTOMATIC_FIX_CYCLES",
  createDiagnosticIssues: "CREATE_DIAGNOSTIC_ISSUES",
  scheduleCron: "SCHEDULE_CRON",
  scheduleTimezone: "SCHEDULE_TIMEZONE",
  maxParallelJobs: "MAX_PARALLEL_JOBS",
  agentProvider: "AGENT_PROVIDER",
  opencodeCodingModel: "OPENCODE_CODING_MODEL",
  opencodeReviewModel: "OPENCODE_REVIEW_MODEL",
  codexCodingModel: "CODEX_CODING_MODEL",
  codexReviewModel: "CODEX_REVIEW_MODEL",
  codexCodingReasoningEffort: "CODEX_CODING_REASONING_EFFORT",
  codexReviewReasoningEffort: "CODEX_REVIEW_REASONING_EFFORT",
  telegramEnabled: "TELEGRAM_ENABLED",
  telegramBotToken: "TELEGRAM_BOT_TOKEN",
  telegramChatId: "TELEGRAM_CHAT_ID",
  heartbeatIntervalMs: "HEARTBEAT_INTERVAL_MS",
  staleJobThresholdMs: "STALE_JOB_THRESHOLD_MS",
  agentTimeoutMs: "AGENT_TIMEOUT_MS",
} as const;

export type RuntimeSettingsPatch = z.infer<typeof runtimeSettingSchema>;
export type RuntimeSettingKey = keyof typeof runtimeToEnvironment;

export const runtimeSettingDefinitions = Object.entries(runtimeToEnvironment).map(([key, environmentKey]) => ({
  key: environmentKey,
  patchKey: key as RuntimeSettingKey,
  secret: environmentKey === "TELEGRAM_BOT_TOKEN" || environmentKey === "TELEGRAM_CHAT_ID",
}));

export function parseRuntimeSettingsPatch(input: unknown) {
  return runtimeSettingSchema.parse(input);
}

export function applyRuntimeSettings(
  config: Config,
  overrides: Record<string, string | undefined>,
  base: Record<string, string | undefined> = configEnvironment(config),
) {
  const environment: Record<string, string | undefined> = { ...base };
  for (const definition of runtimeSettingDefinitions) {
    const value = overrides[definition.key];
    if (value !== undefined) environment[definition.key] = value;
  }
  return parseConfig(environment);
}

export function patchToEnvironment(patch: RuntimeSettingsPatch) {
  const environment: Record<string, string | undefined> = {};
  for (const [patchKey, environmentKey] of Object.entries(runtimeToEnvironment) as Array<[RuntimeSettingKey, string]>) {
    const value = patch[patchKey];
    if (value !== undefined) environment[environmentKey] = String(value);
  }
  return environment;
}

export function configEnvironment(config: Config) {
  return {
    APP_ENV: config.APP_ENV,
    NODE_ENV: config.NODE_ENV,
    DATABASE_URL: config.DATABASE_URL,
    REDIS_URL: config.REDIS_URL,
    SETTINGS_ENCRYPTION_KEY: config.SETTINGS_ENCRYPTION_KEY,
    GITHUB_TOKEN: config.GITHUB_TOKEN,
    GITHUB_REPOSITORIES: config.GITHUB_REPOSITORIES,
    GITHUB_API_URL: config.GITHUB_API_URL,
    GIT_AUTHOR_NAME: config.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: config.GIT_AUTHOR_EMAIL,
    ISSUE_READY_LABEL: config.ISSUE_READY_LABEL,
    ISSUE_WORKING_LABEL: config.ISSUE_WORKING_LABEL,
    ISSUE_BLOCKED_LABEL: config.ISSUE_BLOCKED_LABEL,
    ISSUE_COMPLETED_LABEL: config.ISSUE_COMPLETED_LABEL,
    ISSUE_DECOMPOSED_LABEL: config.ISSUE_DECOMPOSED_LABEL,
    ISSUE_READY_TO_MERGE_LABEL: config.ISSUE_READY_TO_MERGE_LABEL,
    ISSUE_HUMAN_REVIEW_LABEL: config.ISSUE_HUMAN_REVIEW_LABEL,
    PR_REVIEW_REQUESTED_LABEL: config.PR_REVIEW_REQUESTED_LABEL,
    PR_FIX_REQUESTED_LABEL: config.PR_FIX_REQUESTED_LABEL,
    PR_REVIEW_PASSED_LABEL: config.PR_REVIEW_PASSED_LABEL,
    MAX_AUTOMATIC_FIX_CYCLES: String(config.MAX_AUTOMATIC_FIX_CYCLES),
    CREATE_DIAGNOSTIC_ISSUES: String(config.CREATE_DIAGNOSTIC_ISSUES),
    SCHEDULE_CRON: config.SCHEDULE_CRON,
    SCHEDULE_TIMEZONE: config.SCHEDULE_TIMEZONE,
    MAX_PARALLEL_JOBS: String(config.MAX_PARALLEL_JOBS),
    DATA_DIR: config.DATA_DIR,
    AGENT_RUNTIME_DIR: config.AGENT_RUNTIME_DIR,
    AGENT_PROVIDER: config.AGENT_PROVIDER,
    OPENCODE_CODING_MODEL: config.OPENCODE_CODING_MODEL,
    OPENCODE_REVIEW_MODEL: config.OPENCODE_REVIEW_MODEL,
    CODEX_CODING_MODEL: config.CODEX_CODING_MODEL,
    CODEX_REVIEW_MODEL: config.CODEX_REVIEW_MODEL,
    CODEX_CODING_REASONING_EFFORT: config.CODEX_CODING_REASONING_EFFORT,
    CODEX_REVIEW_REASONING_EFFORT: config.CODEX_REVIEW_REASONING_EFFORT,
    TELEGRAM_ENABLED: String(config.TELEGRAM_ENABLED),
    TELEGRAM_BOT_TOKEN: config.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: config.TELEGRAM_CHAT_ID,
    FRONTEND_URL: config.FRONTEND_URL,
    PORT: String(config.PORT),
    WORKER_ID: config.WORKER_ID,
    HEARTBEAT_INTERVAL_MS: String(config.HEARTBEAT_INTERVAL_MS),
    STALE_JOB_THRESHOLD_MS: String(config.STALE_JOB_THRESHOLD_MS),
    AGENT_TIMEOUT_MS: String(config.AGENT_TIMEOUT_MS),
  };
}

export function runtimeSettingsView(config: Config) {
  return {
    githubRepositories: config.GITHUB_REPOSITORIES,
    issueReadyLabel: config.ISSUE_READY_LABEL,
    issueWorkingLabel: config.ISSUE_WORKING_LABEL,
    issueBlockedLabel: config.ISSUE_BLOCKED_LABEL,
    issueCompletedLabel: config.ISSUE_COMPLETED_LABEL,
    issueDecomposedLabel: config.ISSUE_DECOMPOSED_LABEL,
    issueReadyToMergeLabel: config.ISSUE_READY_TO_MERGE_LABEL,
    issueHumanReviewLabel: config.ISSUE_HUMAN_REVIEW_LABEL,
    prReviewRequestedLabel: config.PR_REVIEW_REQUESTED_LABEL,
    prFixRequestedLabel: config.PR_FIX_REQUESTED_LABEL,
    prReviewPassedLabel: config.PR_REVIEW_PASSED_LABEL,
    maxAutomaticFixCycles: config.MAX_AUTOMATIC_FIX_CYCLES,
    createDiagnosticIssues: config.CREATE_DIAGNOSTIC_ISSUES,
    scheduleCron: config.SCHEDULE_CRON,
    scheduleTimezone: config.SCHEDULE_TIMEZONE,
    maxParallelJobs: config.MAX_PARALLEL_JOBS,
    agentProvider: config.AGENT_PROVIDER,
    opencodeCodingModel: config.OPENCODE_CODING_MODEL,
    opencodeReviewModel: config.OPENCODE_REVIEW_MODEL,
    codexCodingModel: config.CODEX_CODING_MODEL,
    codexReviewModel: config.CODEX_REVIEW_MODEL,
    codexCodingReasoningEffort: config.CODEX_CODING_REASONING_EFFORT,
    codexReviewReasoningEffort: config.CODEX_REVIEW_REASONING_EFFORT,
    telegramEnabled: config.TELEGRAM_ENABLED,
    telegramBotTokenConfigured: Boolean(config.TELEGRAM_BOT_TOKEN),
    telegramChatIdConfigured: Boolean(config.TELEGRAM_CHAT_ID),
    heartbeatIntervalMs: config.HEARTBEAT_INTERVAL_MS,
    staleJobThresholdMs: config.STALE_JOB_THRESHOLD_MS,
    agentTimeoutMs: config.AGENT_TIMEOUT_MS,
  };
}

export function runtimeSettingValues(config: Config) {
  const environment = configEnvironment(config);
  return Object.fromEntries(runtimeSettingDefinitions.map(({ key }) => [key, environment[key] ?? ""]));
}

export function telegramBootstrapValues(
  config: Config,
  rows: Array<{ key: string; value: string }>,
): Record<string, string> {
  const hasPersistedCredentials = rows.some(({ key, value }) =>
    (key === "TELEGRAM_BOT_TOKEN" || key === "TELEGRAM_CHAT_ID") && Boolean(value));
  if (hasPersistedCredentials || !config.TELEGRAM_ENABLED || !config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    return {};
  }
  return {
    TELEGRAM_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: config.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: config.TELEGRAM_CHAT_ID,
  };
}

function isCron(value: string) {
  try {
    new CronPattern(value, undefined, { mode: "5-part" });
    return true;
  } catch {
    return false;
  }
}

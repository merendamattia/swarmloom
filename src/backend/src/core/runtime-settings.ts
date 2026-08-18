import { CronPattern } from "croner";
import { z } from "zod";
import type { Config } from "./config-schema.ts";
import { parseConfig } from "./config-schema.ts";

const runtimeSettingSchema = z.object({
  githubRepositories: z.string().min(1).optional(),
  issueReadyLabel: z.string().min(1).optional(),
  issueReviewRequestedLabel: z.string().min(1).optional(),
  issueWorkingLabel: z.string().min(1).optional(),
  issueBlockedLabel: z.string().min(1).optional(),
  issueCompletedLabel: z.string().min(1).optional(),
  issueDecomposedLabel: z.string().min(1).optional(),
  issueHumanReviewLabel: z.string().min(1).optional(),
  scheduleCron: z.string().refine(isCron, "Invalid five-part cron expression").optional(),
  scheduleTimezone: z.string().min(1).optional(),
  maxParallelJobs: z.coerce.number().int().min(1).max(20).optional(),
  agentProvider: z.enum(["codex", "opencode"]).optional(),
  opencodeModel: z.string().min(1).optional(),
  codexModel: z.string().min(1).optional(),
  codexReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
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
  issueReviewRequestedLabel: "ISSUE_REVIEW_REQUESTED_LABEL",
  issueWorkingLabel: "ISSUE_WORKING_LABEL",
  issueBlockedLabel: "ISSUE_BLOCKED_LABEL",
  issueCompletedLabel: "ISSUE_COMPLETED_LABEL",
  issueDecomposedLabel: "ISSUE_DECOMPOSED_LABEL",
  issueHumanReviewLabel: "ISSUE_HUMAN_REVIEW_LABEL",
  scheduleCron: "SCHEDULE_CRON",
  scheduleTimezone: "SCHEDULE_TIMEZONE",
  maxParallelJobs: "MAX_PARALLEL_JOBS",
  agentProvider: "AGENT_PROVIDER",
  opencodeModel: "OPENCODE_MODEL",
  codexModel: "CODEX_MODEL",
  codexReasoningEffort: "CODEX_REASONING_EFFORT",
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

export function applyRuntimeSettings(config: Config, overrides: Record<string, string | undefined>) {
  const environment: Record<string, string | undefined> = configEnvironment(config);
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
    ISSUE_REVIEW_REQUESTED_LABEL: config.ISSUE_REVIEW_REQUESTED_LABEL,
    ISSUE_WORKING_LABEL: config.ISSUE_WORKING_LABEL,
    ISSUE_BLOCKED_LABEL: config.ISSUE_BLOCKED_LABEL,
    ISSUE_COMPLETED_LABEL: config.ISSUE_COMPLETED_LABEL,
    ISSUE_DECOMPOSED_LABEL: config.ISSUE_DECOMPOSED_LABEL,
    ISSUE_HUMAN_REVIEW_LABEL: config.ISSUE_HUMAN_REVIEW_LABEL,
    SCHEDULE_CRON: config.SCHEDULE_CRON,
    SCHEDULE_TIMEZONE: config.SCHEDULE_TIMEZONE,
    MAX_PARALLEL_JOBS: String(config.MAX_PARALLEL_JOBS),
    DATA_DIR: config.DATA_DIR,
    AGENT_RUNTIME_DIR: config.AGENT_RUNTIME_DIR,
    AGENT_PROVIDER: config.AGENT_PROVIDER,
    OPENCODE_MODEL: config.OPENCODE_MODEL,
    CODEX_MODEL: config.CODEX_MODEL,
    CODEX_REASONING_EFFORT: config.CODEX_REASONING_EFFORT,
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
    issueReviewRequestedLabel: config.ISSUE_REVIEW_REQUESTED_LABEL,
    issueWorkingLabel: config.ISSUE_WORKING_LABEL,
    issueBlockedLabel: config.ISSUE_BLOCKED_LABEL,
    issueCompletedLabel: config.ISSUE_COMPLETED_LABEL,
    issueDecomposedLabel: config.ISSUE_DECOMPOSED_LABEL,
    issueHumanReviewLabel: config.ISSUE_HUMAN_REVIEW_LABEL,
    scheduleCron: config.SCHEDULE_CRON,
    scheduleTimezone: config.SCHEDULE_TIMEZONE,
    maxParallelJobs: config.MAX_PARALLEL_JOBS,
    agentProvider: config.AGENT_PROVIDER,
    opencodeModel: config.OPENCODE_MODEL,
    codexModel: config.CODEX_MODEL,
    codexReasoningEffort: config.CODEX_REASONING_EFFORT,
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

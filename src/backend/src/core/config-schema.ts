import { CronPattern } from "croner";
import { z } from "zod";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const optionalNonEmptyString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

function isRepositoryName(value: string) {
  if (!repositoryPattern.test(value)) return false;
  return value.split("/").every((part) => part !== "." && part !== "..");
}

function parseRepositories(value: string) {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
}

function isCron(value: string) {
  try {
    new CronPattern(value, undefined, { mode: "5-part" });
    return true;
  } catch {
    return false;
  }
}

const environmentSchema = z.object({
  APP_ENV: z.enum(["local", "test", "production"]).default("local"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url().refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol), {
    message: "must use the postgresql:// scheme",
  }),
  REDIS_URL: z.url().refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol), {
    message: "must use the redis:// or rediss:// scheme",
  }),
  SETTINGS_ENCRYPTION_KEY: z.string().min(32),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPOSITORIES: z.string().min(1),
  GITHUB_API_URL: z.url().default("https://api.github.com"),
  GIT_AUTHOR_NAME: z.string().min(1).default("github-agent-worker"),
  GIT_AUTHOR_EMAIL: z.email().default("github-agent-worker@users.noreply.github.com"),
  ISSUE_READY_LABEL: z.string().min(1).default("agent:ready"),
  ISSUE_WORKING_LABEL: z.string().min(1).default("agent:working"),
  ISSUE_BLOCKED_LABEL: z.string().min(1).default("agent:blocked"),
  ISSUE_COMPLETED_LABEL: z.string().min(1).default("agent:done"),
  ISSUE_DECOMPOSED_LABEL: z.string().min(1).default("agent:decomposed"),
  ISSUE_HUMAN_REVIEW_LABEL: z.string().min(1).default("agent:human-review"),
  SCHEDULE_CRON: z.string().refine(isCron).default("*/30 * * * *"),
  SCHEDULE_TIMEZONE: z.string().min(1).default("UTC"),
  MAX_PARALLEL_JOBS: z.coerce.number().int().min(1).max(20).default(1),
  DATA_DIR: z.string().min(1).default("./data"),
  AGENT_RUNTIME_DIR: z.string().min(1).default("./agent-runtime"),
  AGENT_PROVIDER: z.enum(["codex", "opencode"]),
  OPENCODE_MODEL: z.string().min(1).default("opencode-go/deepseek-v4-flash"),
  CODEX_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  CODEX_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"])
    .default("max"),
  TELEGRAM_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  TELEGRAM_BOT_TOKEN: optionalNonEmptyString,
  TELEGRAM_CHAT_ID: optionalNonEmptyString,
  FRONTEND_URL: z.url().default("http://localhost:18420"),
  PORT: z.coerce.number().int().positive().default(18_421),
  WORKER_ID: z.string().min(1).default("local-worker-1"),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  STALE_JOB_THRESHOLD_MS: z.coerce.number().int().min(5_000).default(60_000),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(7_200_000),
}).superRefine((value, context) => {
  const repositories = parseRepositories(value.GITHUB_REPOSITORIES);
  if (repositories.length === 0 || repositories.some((repository) => !isRepositoryName(repository))) {
    context.addIssue({
      code: "custom",
      path: ["GITHUB_REPOSITORIES"],
      message: "Use comma or whitespace separated owner/repository values",
    });
  }
  if (value.HEARTBEAT_INTERVAL_MS >= value.STALE_JOB_THRESHOLD_MS) {
    context.addIssue({
      code: "custom",
      path: ["HEARTBEAT_INTERVAL_MS"],
      message: "Heartbeat interval must be shorter than the stale threshold",
    });
  }
  if (value.TELEGRAM_ENABLED && (!value.TELEGRAM_BOT_TOKEN || !value.TELEGRAM_CHAT_ID)) {
    context.addIssue({
      code: "custom",
      path: ["TELEGRAM_ENABLED"],
      message: "Telegram token and chat ID are required when Telegram is enabled",
    });
  }
});

export function parseConfig(input: Record<string, string | undefined>) {
  const parsed = environmentSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment configuration: ${problems.join("; ")}`);
  }
  return { ...parsed.data, githubRepositories: parseRepositories(parsed.data.GITHUB_REPOSITORIES) };
}

export type Config = ReturnType<typeof parseConfig>;

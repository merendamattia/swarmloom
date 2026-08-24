import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config-schema.ts";

const required = {
  DATABASE_URL: "postgresql://worker:worker@localhost:17432/swarmloom",
  REDIS_URL: "redis://localhost:18422",
  SETTINGS_ENCRYPTION_KEY: "test-settings-encryption-key-0123456789",
  GITHUB_TOKEN: "test-token",
  GITHUB_REPOSITORIES: "acme/api, acme/web\nacme/api",
  AGENT_PROVIDER: "codex",
};

describe("configuration", () => {
  test("normalizes repositories and applies agent defaults", () => {
    const config = parseConfig(required);

    expect(config.githubRepositories).toEqual(["acme/api", "acme/web"]);
    expect(config.AGENT_PROVIDER).toBe("codex");
    expect(config.CODEX_CODING_MODEL).toBe("gpt-5.6-luna");
    expect(config.CODEX_REVIEW_MODEL).toBe("gpt-5.6-luna");
    expect(config.CODEX_CODING_REASONING_EFFORT).toBe("max");
    expect(config.CODEX_REVIEW_REASONING_EFFORT).toBe("max");
    expect(config.OPENCODE_CODING_MODEL).toBe("opencode-go/deepseek-v4-flash");
    expect(config.OPENCODE_REVIEW_MODEL).toBe("opencode-go/deepseek-v4-flash");
    expect(config.ISSUE_READY_LABEL).toBe("agent:ready");
    expect(config.PR_REVIEW_REQUESTED_LABEL).toBe("agent:review-requested");
    expect(config.ISSUE_HUMAN_REVIEW_LABEL).toBe("agent:human-review");
    expect(config.ISSUE_READY_TO_MERGE_LABEL).toBe("agent:ready-to-merge");
    expect(config.MAX_AUTOMATIC_FIX_CYCLES).toBe(5);
    expect(config.CREATE_DIAGNOSTIC_ISSUES).toBe(false);
    expect(config.MAX_PARALLEL_JOBS).toBe(1);
    expect(config.SCHEDULE_CRON).toBe("*/30 * * * *");
  });

  test("rejects malformed repositories", () => {
    expect(() => parseConfig({ ...required, GITHUB_REPOSITORIES: "acme, /repo,acme/repo/extra,../repo,acme/.." }))
      .toThrow("Invalid environment configuration");
  });

  test("rejects repository names that can escape the persistent data root", () => {
    expect(() => parseConfig({ ...required, GITHUB_REPOSITORIES: "../repo" }))
      .toThrow("Invalid environment configuration");
    expect(() => parseConfig({ ...required, GITHUB_REPOSITORIES: "acme/.." }))
      .toThrow("Invalid environment configuration");
  });

  test("requires Telegram credentials only when Telegram is enabled", () => {
    expect(parseConfig({
      ...required,
      TELEGRAM_ENABLED: "false",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "  ",
    }).TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(() => parseConfig({ ...required, TELEGRAM_ENABLED: "true" }))
      .toThrow("Invalid environment configuration");
    expect(parseConfig({
      ...required,
      TELEGRAM_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "1234",
    }).TELEGRAM_ENABLED).toBe(true);
  });

  test("keeps heartbeat shorter than stale recovery threshold", () => {
    expect(() => parseConfig({
      ...required,
      HEARTBEAT_INTERVAL_MS: "60000",
      STALE_JOB_THRESHOLD_MS: "60000",
    })).toThrow("Invalid environment configuration");
  });

  test("rejects an invalid schedule before startup", () => {
    expect(() => parseConfig({ ...required, SCHEDULE_CRON: "not a cron" }))
      .toThrow("Invalid environment configuration");
  });

  test("requires PostgreSQL and reports the invalid field without echoing its value", () => {
    expect(() => parseConfig({ ...required, DATABASE_URL: "https://database.example.com/secret" }))
      .toThrow("DATABASE_URL: must use the postgresql:// scheme");
  });
});

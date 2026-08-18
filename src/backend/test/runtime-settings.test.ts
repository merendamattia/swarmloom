import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config-schema.ts";
import { decryptSetting, encryptSetting } from "../src/core/settings-crypto.ts";
import {
  applyRuntimeSettings,
  configEnvironment,
  parseRuntimeSettingsPatch,
  telegramBootstrapValues,
} from "../src/core/runtime-settings.ts";

const key = "test-settings-encryption-key-0123456789";
const base = parseConfig({
  DATABASE_URL: "postgresql://worker:worker@localhost:17432/swarmloom",
  REDIS_URL: "redis://localhost:18422",
  SETTINGS_ENCRYPTION_KEY: key,
  GITHUB_TOKEN: "test-token",
  GITHUB_REPOSITORIES: "acme/api",
  AGENT_PROVIDER: "codex",
});

describe("runtime settings", () => {
  test("applies validated settings without changing technical configuration", () => {
    const config = applyRuntimeSettings(base, {
      SCHEDULE_CRON: "*/5 * * * *",
      MAX_PARALLEL_JOBS: "3",
      AGENT_PROVIDER: "opencode",
      OPENCODE_MODEL: "opencode-go/test-model",
      ISSUE_READY_LABEL: "ready-for-agent",
      ISSUE_REVIEW_REQUESTED_LABEL: "review-requested",
    });

    expect(config.SCHEDULE_CRON).toBe("*/5 * * * *");
    expect(config.MAX_PARALLEL_JOBS).toBe(3);
    expect(config.AGENT_PROVIDER).toBe("opencode");
    expect(config.OPENCODE_MODEL).toBe("opencode-go/test-model");
    expect(config.ISSUE_READY_LABEL).toBe("ready-for-agent");
    expect(config.ISSUE_REVIEW_REQUESTED_LABEL).toBe("review-requested");
    expect(config.DATABASE_URL).toBe(base.DATABASE_URL);
    expect(config.GITHUB_TOKEN).toBe(base.GITHUB_TOKEN);
  });

  test("rejects an invalid runtime patch at the API boundary", () => {
    expect(() => parseRuntimeSettingsPatch({ MAX_PARALLEL_JOBS: 0 })).toThrow();
    expect(() => parseRuntimeSettingsPatch({ SCHEDULE_CRON: "not cron" })).toThrow();
  });

  test("encrypts and decrypts Telegram settings without storing plaintext", () => {
    const encrypted = encryptSetting("bot-token", key);

    expect(encrypted).not.toContain("bot-token");
    expect(decryptSetting(encrypted, key)).toBe("bot-token");
  });

  test("bootstraps Telegram env values until Settings has credentials", () => {
    const telegramConfig = parseConfig({
      ...configEnvironment(base),
      TELEGRAM_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "123",
    });

    expect(telegramBootstrapValues(telegramConfig, [])).toEqual({
      TELEGRAM_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "123",
    });
    expect(telegramBootstrapValues(telegramConfig, [
      { key: "TELEGRAM_BOT_TOKEN", value: "encrypted-token" },
    ])).toEqual({});
  });
});

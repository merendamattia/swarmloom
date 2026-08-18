import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config-schema.ts";
import { replaceWorkerLabels } from "../src/github/labels.ts";

const config = parseConfig({
  DATABASE_URL: "postgresql://worker:worker@localhost:5432/worker",
  REDIS_URL: "redis://localhost:18422",
  SETTINGS_ENCRYPTION_KEY: "test-settings-encryption-key-0123456789",
  GITHUB_TOKEN: "test-token",
  GITHUB_REPOSITORIES: "acme/app",
  AGENT_PROVIDER: "codex",
});

describe("worker labels", () => {
  test("marks blocked issues for human review while preserving unrelated labels", () => {
    expect(replaceWorkerLabels(
      ["bug", config.ISSUE_WORKING_LABEL],
      config,
      [config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL],
    )).toEqual(["bug", config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL]);
  });
});

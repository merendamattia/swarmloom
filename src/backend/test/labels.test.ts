import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config-schema.ts";
import { acquireIssueLabels, agentLabelDefinitions, replaceWorkerLabels } from "../src/github/labels.ts";

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

  test("treats review requested as a worker trigger and preserves it while working", () => {
    expect(agentLabelDefinitions(config).map(({ name }) => name))
      .toContain(config.ISSUE_REVIEW_REQUESTED_LABEL);
    expect(acquireIssueLabels(
      ["bug", config.ISSUE_REVIEW_REQUESTED_LABEL],
      config,
    )).toEqual(["bug", config.ISSUE_REVIEW_REQUESTED_LABEL, config.ISSUE_WORKING_LABEL]);
  });

  test("acquiring a fresh issue removes only the ready label and keeps every other label", () => {
    expect(acquireIssueLabels(
      ["bug", "frontend", config.ISSUE_READY_LABEL],
      config,
    )).toEqual(["bug", "frontend", config.ISSUE_WORKING_LABEL]);
    expect(acquireIssueLabels(
      ["bug", config.ISSUE_READY_LABEL, config.ISSUE_REVIEW_REQUESTED_LABEL],
      config,
    )).toEqual(["bug", config.ISSUE_REVIEW_REQUESTED_LABEL, config.ISSUE_WORKING_LABEL]);
  });
});

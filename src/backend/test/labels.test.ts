import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config-schema.ts";
import {
  acquireIssueLabels,
  agentLabelDefinitions,
  replacePullRequestLabels,
  replaceWorkerLabels,
} from "../src/github/labels.ts";

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

  test("keeps issue and pull request label definitions separate", () => {
    const names = agentLabelDefinitions(config).map(({ name }) => name);
    expect(names).toContain(config.ISSUE_READY_TO_MERGE_LABEL);
    expect(names).toContain(config.PR_REVIEW_REQUESTED_LABEL);
    expect(names).toContain(config.PR_FIX_REQUESTED_LABEL);
    expect(names).toContain(config.PR_REVIEW_PASSED_LABEL);
  });

  test("acquiring a fresh issue replaces stale worker states and keeps unrelated labels", () => {
    expect(acquireIssueLabels(
      ["bug", "frontend", config.ISSUE_READY_LABEL, config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL],
      config,
    )).toEqual(["bug", "frontend", config.ISSUE_WORKING_LABEL]);
  });

  test("pull request transitions replace only the pull request workflow labels", () => {
    expect(replacePullRequestLabels(
      ["feature", config.PR_REVIEW_REQUESTED_LABEL],
      config,
      [config.PR_FIX_REQUESTED_LABEL],
    )).toEqual(["feature", config.PR_FIX_REQUESTED_LABEL]);
    expect(replacePullRequestLabels(
      ["feature", config.PR_FIX_REQUESTED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL],
      config,
      [config.PR_REVIEW_PASSED_LABEL],
    )).toEqual(["feature", config.PR_REVIEW_PASSED_LABEL]);
  });
});

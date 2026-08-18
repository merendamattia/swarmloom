import { describe, expect, test } from "bun:test";
import { pullRequestCheckState } from "../src/runner/pull-request.ts";

describe("pull request checks", () => {
  test("waits while a check is queued or running", () => {
    expect(pullRequestCheckState([
      { name: "CI", status: "in_progress", conclusion: null, url: null },
    ])).toBe("pending");
  });

  test("fails when a completed check has a failing conclusion", () => {
    expect(pullRequestCheckState([
      { name: "CI", status: "completed", conclusion: "failure", url: null },
    ])).toBe("failed");
  });

  test("passes when checks are successful, skipped, or absent", () => {
    expect(pullRequestCheckState([])).toBe("passed");
    expect(pullRequestCheckState([
      { name: "CI", status: "completed", conclusion: "success", url: null },
      { name: "Deploy", status: "completed", conclusion: "skipped", url: null },
    ])).toBe("passed");
  });
});

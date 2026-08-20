import { describe, expect, test } from "bun:test";
import { parseJobOutcome, parsePullRequestUrl, parseReviewOutcome } from "../src/runner/response.ts";

describe("agent responses", () => {
  test("parses the four explicit job outcomes from the first marker line", () => {
    expect(parseJobOutcome("Outcome: requires_decomposition\nTL;DR: Requires decomposition.\nReason: Two releases")).toBe("requires_decomposition");
    expect(parseJobOutcome("Outcome: blocked\nTL;DR: Blocked pending an API key.\nMissing an API key.")).toBe("blocked");
    expect(parseJobOutcome("Outcome: decomposed\nTL;DR: Split the work into two children.\nSplit into two children.")).toBe("decomposed");
    expect(parseJobOutcome("Outcome: implemented\nPR: https://github.com/a/b/pull/4\nTL;DR: Implemented and opened the pull request.\nDone.")).toBe("implemented");
  });

  test("is case- and whitespace-insensitive for the marker", () => {
    expect(parseJobOutcome("  outcome:  implemented  \nTL;DR: Implemented.")).toBe("implemented");
    expect(parseJobOutcome("\nOutcome: blocked\n\nTL;DR: Blocked.")).toBe("blocked");
  });

  test("rejects prose without a valid outcome marker", () => {
    expect(() => parseJobOutcome("Done and done")).toThrow("Outcome:");
    expect(() => parseJobOutcome("Outcome: maybe")).toThrow("Outcome:");
  });

  test("rejects a missing or misplaced TL;DR before publication", () => {
    expect(() => parseJobOutcome("Outcome: blocked\nDetailed explanation.\n\nTL;DR: Blocked.")).toThrow("TL;DR:");
    expect(() => parseJobOutcome("Outcome: implemented\nTL;DR: Implemented.\nPR: https://github.com/a/b/pull/4")).toThrow("TL;DR:");
    expect(() => parseReviewOutcome("Review: pass\nDetailed findings.\n\nTL;DR: Passed.")).toThrow("TL;DR:");
  });

  test("parses review pass and changes_requested", () => {
    expect(parseReviewOutcome("Review: pass\nTL;DR: The review passed.\nLooks good.")).toBe("pass");
    expect(parseReviewOutcome("review: changes_requested\nTL;DR: Changes are required.\nFix the guard.")).toBe("changes_requested");
    expect(() => parseReviewOutcome("Everything is fine")).toThrow("Review:");
  });

  test("extracts the PR url from an implemented response", () => {
    expect(parsePullRequestUrl("Outcome: implemented\nPR: https://github.com/a/b/pull/42\nTL;DR: Implemented and opened the pull request.\nDone."))
      .toBe("https://github.com/a/b/pull/42");
    expect(parsePullRequestUrl("Outcome: blocked\nTL;DR: Blocked without a pull request.\nNo PR.")).toBeNull();
    expect(parsePullRequestUrl("Outcome: implemented\nTL;DR: Implemented without a pull request.\nNo pull request.")).toBeNull();
  });
});

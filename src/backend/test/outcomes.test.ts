import { describe, expect, test } from "bun:test";
import { parseJobOutcome, parsePullRequestUrl, parseReviewOutcome, parseVisualEvidence } from "../src/runner/response.ts";

describe("agent responses", () => {
  test("parses the four explicit job outcomes from the first marker line", () => {
    expect(parseJobOutcome("Outcome: requires_decomposition\nReason: Two releases")).toBe("requires_decomposition");
    expect(parseJobOutcome("Outcome: blocked\nMissing an API key.")).toBe("blocked");
    expect(parseJobOutcome("Outcome: decomposed\nSplit into children.")).toBe("decomposed");
    expect(parseJobOutcome("Outcome: implemented\nPR: https://github.com/a/b/pull/4\nDone.")).toBe("implemented");
  });

  test("is case- and whitespace-insensitive for the marker", () => {
    expect(parseJobOutcome("  outcome:  implemented  ")).toBe("implemented");
    expect(parseJobOutcome("\nOutcome: blocked\n\n")).toBe("blocked");
  });

  test("rejects prose without a valid outcome marker", () => {
    expect(() => parseJobOutcome("Done and done")).toThrow("Outcome:");
    expect(() => parseJobOutcome("Outcome: maybe")).toThrow("Outcome:");
  });

  test("parses review pass and changes_requested", () => {
    expect(parseReviewOutcome("Review: pass\nLooks good.")).toBe("pass");
    expect(parseReviewOutcome("review: changes_requested\nFix the guard.")).toBe("changes_requested");
    expect(() => parseReviewOutcome("Everything is fine")).toThrow("Review:");
  });

  test("extracts the PR url from an implemented response", () => {
    expect(parsePullRequestUrl("Outcome: implemented\nPR: https://github.com/a/b/pull/42\nDone."))
      .toBe("https://github.com/a/b/pull/42");
    expect(parsePullRequestUrl("Outcome: blocked\nNo PR.")).toBeNull();
    expect(parsePullRequestUrl("Outcome: implemented\nNo pull request.")).toBeNull();
  });

  test("parses visual evidence from an implemented response", () => {
    expect(parseVisualEvidence("Outcome: implemented\nVisual: /settings\nDone."))
      .toEqual({ route: "/settings" });
    expect(parseVisualEvidence("Outcome: implemented\nvisual:  /dashboard \nSetup: npm ci && npm run dev\nDone."))
      .toEqual({ route: "/dashboard", setupNote: "npm ci && npm run dev" });
    expect(parseVisualEvidence("Outcome: implemented\nPR: https://github.com/a/b/pull/1\nDone.")).toBeNull();
    expect(parseVisualEvidence("Outcome: blocked\nNo frontend.")).toBeNull();
  });
});

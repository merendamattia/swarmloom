import { expect, test } from "bun:test";
import {
  agentOutputEvents,
  agentOutputMessage,
  dateTime,
  diagnosticsBundle,
  duration,
  inlineMarkdown,
  normalizeAgentOutput,
  normalizeDiagnostics,
  normalizeJobResult,
  normalizeReview,
  shortCommit,
  statusLabel,
} from "./format.ts";

test("formats a valid timestamp", () => {
  expect(dateTime("2026-08-05T12:00:00Z")).toMatch(/\d{1,2}:\d{2}:\d{2}/);
});

test("keeps only non-empty agent output for the timeline", () => {
  expect(agentOutputEvents([
    { type: "JOB_STARTED", message: "Started" },
    { type: "AGENT_OUTPUT", message: "Current output" },
    { type: "AGENT_AGENT_OUTPUT", message: "" },
    { type: "AGENT_AGENT_OUTPUT", message: "Implemented bubble sort" },
  ])).toEqual([
    { type: "AGENT_OUTPUT", message: "Current output" },
    { type: "AGENT_AGENT_OUTPUT", message: "Implemented bubble sort" },
  ]);
});

test("uses the verified PR URL in redacted agent output", () => {
  expect(agentOutputMessage(
    '"url":"https://github.com/[REDACTED]/test-vari/pull/5"',
    "https://github.com/acme/test-vari/pull/5",
  )).toBe('"url":"https://github.com/acme/test-vari/pull/5"');
});

test("normalizes Codex JSON output for the timeline", () => {
  expect(normalizeAgentOutput(JSON.stringify({
    outcome: "implemented",
    summary: "README updated.",
    tests: null,
    commit: null,
    pr: null,
    reason: null,
    childIssues: null,
    question: null,
  }))).toEqual({ outcome: "implemented", summary: "README updated." });
});

test("normalizes the implemented result for structured rendering", () => {
  expect(normalizeJobResult({
    outcome: "implemented",
    summary: "Implemented the requested change.",
    tests: ["bun test", "bun run build"],
    commit: "1234567890abcdef",
    pr: { number: 42, url: "https://github.com/acme/app/pull/42", base: "develop", head: "agent/42" },
  })).toEqual({
    outcome: "implemented",
    summary: "Implemented the requested change.",
    tests: ["bun test", "bun run build"],
    commit: "1234567890abcdef",
    pr: { number: 42, url: "https://github.com/acme/app/pull/42", base: "develop", head: "agent/42" },
  });
});

test("normalizes review verdict and findings without exposing JSON", () => {
  expect(normalizeReview(
    { verdict: "changes_requested", summary: "One issue needs attention." },
    [{ file: "src/app.ts", line: 12, severity: "high", problem: "It can fail.", correction: "Handle the error." }],
  )).toEqual({
    verdict: "changes_requested",
    summary: "One issue needs attention.",
    findings: [{ file: "src/app.ts", line: 12, severity: "high", problem: "It can fail.", correction: "Handle the error." }],
  });
});

test("renders the small Markdown subset used in provider summaries", () => {
  expect(inlineMarkdown("Use **strict** mode and `bun test`. [PR](https://github.com/acme/app/pull/1)")).toEqual([
    { kind: "text", value: "Use " },
    { kind: "strong", value: "strict" },
    { kind: "text", value: " mode and " },
    { kind: "code", value: "bun test" },
    { kind: "text", value: ". " },
    { kind: "link", value: "PR", href: "https://github.com/acme/app/pull/1" },
  ]);
});

test("formats operational values", () => {
  expect(duration(125_000)).toBe("2m 5s");
  expect(statusLabel("CHANGES_REQUESTED")).toBe("Changes requested");
  expect(shortCommit("1234567890abcdef")).toBe("12345678");
});

test("normalizes persisted failure diagnostics", () => {
  expect(normalizeDiagnostics({
    stage: "parser",
    role: "issue-worker",
    provider: "codex",
    model: "gpt-5",
    sessionId: "session-1",
    exitCode: 0,
    error: "Agent result is not valid JSON",
    causeChain: ["Agent result is not valid JSON", "Unexpected token"],
    stderr: "",
    finalOutput: '{"outcome": "implemented", trailing',
    events: [{ type: "SESSION_STARTED", timestamp: "2026-01-01T00:00:00Z" }],
  })).toEqual({
    stage: "parser",
    role: "issue-worker",
    provider: "codex",
    model: "gpt-5",
    sessionId: "session-1",
    exitCode: 0,
    error: "Agent result is not valid JSON",
    causeChain: ["Agent result is not valid JSON", "Unexpected token"],
    stderr: null,
    finalOutput: '{"outcome": "implemented", trailing',
    events: [{ type: "SESSION_STARTED", timestamp: "2026-01-01T00:00:00Z", message: null, tool: null }],
  });
});

test("rejects non-diagnostic payloads", () => {
  expect(normalizeDiagnostics(null)).toBeNull();
  expect(normalizeDiagnostics({ stage: "" })).toBeNull();
  expect(normalizeDiagnostics("Agent result is not valid JSON")).toBeNull();
});

test("builds a complete sanitized diagnostic bundle", () => {
  const bundle = diagnosticsBundle({
    stage: "parser",
    role: "issue-worker",
    provider: "codex",
    model: "gpt-5",
    sessionId: "session-1",
    exitCode: 0,
    error: "Agent result is not valid JSON",
    causeChain: ["Agent result is not valid JSON"],
    stderr: null,
    finalOutput: '{"outcome": "implemented", trailing',
    events: [{ type: "SESSION_STARTED", timestamp: "2026-01-01T00:00:00Z", message: null, tool: null }],
  });
  expect(bundle).toContain("Stage: Parser");
  expect(bundle).toContain("Session: session-1");
  expect(bundle).toContain("Stderr: Not recorded");
  expect(bundle).toContain("Final provider output: {\"outcome\": \"implemented\", trailing");
  expect(bundle).toContain("[2026-01-01T00:00:00Z] SESSION_STARTED");
  expect(bundle).toContain("Cause chain:");
});

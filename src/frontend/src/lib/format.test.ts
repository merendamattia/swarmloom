import { expect, test } from "bun:test";
import {
  activeDuration,
  agentOutputEvents,
  agentOutputMessage,
  dateTime,
  diagnosticsBundle,
  duration,
  formatTokens,
  inlineMarkdown,
  normalizeDiagnostics,
  shortCommit,
  statusLabel,
  quotaWaitDuration,
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
  expect(formatTokens(1_120)).toBe("1,120");
  expect(formatTokens("9007199254740993")).toBe("9,007,199,254,740,993");
  expect(formatTokens(null)).toBe("Not recorded");
  expect(activeDuration(1_000, null)).toBe("1s");
  expect(quotaWaitDuration(1_000, null)).toBe("1s");
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
    error: "Agent response must start with Outcome:",
    stack: "Error: parser failed\n    at parse (runner.ts:1:1)",
    causeChain: ["Agent response must start with Outcome:", "trailing prose"],
    stderr: "",
    finalOutput: "trailing prose",
    events: [{ type: "SESSION_STARTED", timestamp: "2026-01-01T00:00:00Z" }],
  })).toEqual({
    stage: "parser",
    role: "issue-worker",
    provider: "codex",
    model: "gpt-5",
    sessionId: "session-1",
    exitCode: 0,
    error: "Agent response must start with Outcome:",
    stack: "Error: parser failed\n    at parse (runner.ts:1:1)",
    causeChain: ["Agent response must start with Outcome:", "trailing prose"],
    stderr: null,
    finalOutput: "trailing prose",
    events: [{ type: "SESSION_STARTED", timestamp: "2026-01-01T00:00:00Z", message: null, tool: null }],
  });
});

test("rejects non-diagnostic payloads", () => {
  expect(normalizeDiagnostics(null)).toBeNull();
  expect(normalizeDiagnostics({ stage: "" })).toBeNull();
  expect(normalizeDiagnostics("Agent response must start with Outcome:")).toBeNull();
});

test("builds a complete sanitized diagnostic bundle", () => {
  const bundle = diagnosticsBundle({
    stage: "parser",
    role: "issue-worker",
    provider: "codex",
    model: "gpt-5",
    sessionId: "session-1",
    exitCode: 0,
    error: "Agent response must start with Outcome:",
    stack: "Error: parser failed\n    at parse (runner.ts:1:1)",
    causeChain: ["Agent response must start with Outcome:"],
    stderr: null,
    finalOutput: "trailing prose",
    events: [{ type: "SESSION_STARTED", timestamp: "2026-01-01T00:00:00Z", message: null, tool: null }],
  });
  expect(bundle).toContain("Stage: Parser");
  expect(bundle).toContain("Session: session-1");
  expect(bundle).toContain("Stack trace:\nError: parser failed");
  expect(bundle).toContain("Stderr: Not recorded");
  expect(bundle).toContain("Final provider output: trailing prose");
  expect(bundle).toContain("[2026-01-01T00:00:00Z] SESSION_STARTED");
  expect(bundle).toContain("Cause chain:");
});

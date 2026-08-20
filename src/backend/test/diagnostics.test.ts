import { describe, expect, test } from "bun:test";
import {
  AgentExecutionError,
  causeChain,
  minimalDiagnostics,
  tail,
} from "../src/runner/diagnostics.ts";

describe("job diagnostics", () => {
  const environment = { GITHUB_TOKEN: "secret-token", APP_SECRET: "app-secret-value" };

  test("walks the redacted cause chain", () => {
    const original = new Error("inner secret-token failure");
    const wrapped = new Error("Provider emitted invalid JSONL", { cause: original });
    expect(causeChain(wrapped, environment)).toEqual([
      "Provider emitted invalid JSONL",
      "inner [REDACTED] failure",
    ]);
  });

  test("keeps a single entry for plain string causes", () => {
    expect(causeChain("bun exited 2", environment)).toEqual(["bun exited 2"]);
  });

  test("builds a minimal job-level bundle without inventing evidence", () => {
    const diagnostics = minimalDiagnostics(new Error("job secret-token broke"), {
      provider: "codex",
      model: "test-model",
    }, environment);
    expect(diagnostics).toEqual({
      stage: "job",
      role: null,
      provider: "codex",
      model: "test-model",
      sessionId: null,
      exitCode: null,
      error: "job [REDACTED] broke",
      causeChain: ["job [REDACTED] broke"],
      events: [],
    });
  });

  test("truncates oversized output while keeping the tail", () => {
    expect(tail("x".repeat(100), 10)).toBe("[truncated]\nxxxxxxxxxx");
    expect(tail("short", 10)).toBe("short");
  });

  test("carries structured diagnostics on the execution error", () => {
    const error = new AgentExecutionError("Agent response must start with Outcome:", {
      stage: "parser",
      role: "issue-worker",
      provider: "codex",
      model: "gpt-5",
      sessionId: "session-1",
      exitCode: 0,
      error: "Agent response must start with Outcome:",
      causeChain: ["Agent response must start with Outcome:"],
      finalOutput: "trailing prose",
      events: [{ type: "AGENT_OUTPUT", timestamp: "2026-01-01T00:00:00Z", message: "thinking" }],
    });
    expect(error.name).toBe("AgentExecutionError");
    expect(error.diagnostics.stage).toBe("parser");
    expect(error.diagnostics.events[0]?.message).toBe("thinking");
  });
});

import { describe, expect, mock, test } from "bun:test";
import { buildCodexCommand, normalizeCodexEvent } from "../src/providers/codex.ts";
import {
  buildOpenCodeCommand, normalizeOpenCodeEvent, openCodeEnvironment, OpenCodeProvider,
} from "../src/providers/opencode.ts";
import { redactSecrets } from "../src/core/secrets.ts";
import type { AgentEvent, AgentRequest } from "../src/providers/types.ts";

const request: AgentRequest = {
  role: "issue-worker",
  workingDirectory: "/work/repository",
  task: "Implement issue #12",
  context: "Base commit abc123",
  model: "test-model",
  reasoningEffort: "max",
  outputSchemaPath: "/runtime/result.schema.json",
};

describe("Codex provider", () => {
  test("builds a fresh, noninteractive, schema-constrained command", () => {
    expect(buildCodexCommand(request)).toEqual([
      "codex", "exec", "--json", "--ignore-user-config", "--model", "test-model",
      "--approve-for-me", "--config",
      'model_reasoning_effort="max"', "--cd", "/work/repository", "--output-schema",
      "/runtime/result.schema.json", "-",
    ]);
  });

  test("normalizes session, output, tool and completion events", () => {
    expect(normalizeCodexEvent({ type: "thread.started", thread_id: "thread-1" })).toMatchObject({
      sessionId: "thread-1",
      event: { type: "SESSION_STARTED" },
    });
    expect(normalizeCodexEvent({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text: "Done" },
    })).toMatchObject({ output: "Done", event: { type: "AGENT_OUTPUT", message: "Done" } });
    expect(normalizeCodexEvent({
      type: "item.started",
      item: { id: "item-2", type: "command_execution", command: "bun test" },
    })).toMatchObject({ event: { type: "TOOL_STARTED", tool: "command_execution" } });
    expect(normalizeCodexEvent({ type: "turn.completed" })).toMatchObject({
      event: { type: "SESSION_COMPLETED" },
    });
  });

  test("surfaces the real message from nested provider errors", () => {
    expect(normalizeCodexEvent({
      type: "error",
      error: { name: "APIError", data: { message: "Insufficient balance" } },
    })).toMatchObject({ event: { type: "SESSION_FAILED", message: "Insufficient balance" } });
    expect(normalizeCodexEvent({ type: "turn.failed", error: { message: "model unavailable" } }))
      .toMatchObject({ event: { type: "SESSION_FAILED", message: "model unavailable" } });
    expect(normalizeCodexEvent({ type: "error" })).toMatchObject({
      event: { type: "SESSION_FAILED", message: "Codex session failed" },
    });
  });
});

describe("OpenCode provider", () => {
  test("builds a fresh JSON command without putting the prompt in argv", () => {
    expect(buildOpenCodeCommand(request)).toEqual([
      "opencode", "run", "--format", "json", "--model", "test-model",
      "--dir", "/work/repository", "--title", "Swarmloom: issue-worker",
    ]);
    const key = ["VENDOR", "API", "KEY"].join("_");
    const environment = openCodeEnvironment({ [key]: "secret" });
    expect(environment.OPENCODE_PERMISSION).toBe('{"*":"allow"}');
    expect(key in environment).toBe(false);
  });

  test("normalizes session, output, tool and completion events", () => {
    expect(normalizeOpenCodeEvent({ type: "step_start", sessionID: "session-1" })).toMatchObject({
      sessionId: "session-1",
      event: { type: "SESSION_STARTED" },
    });
    expect(normalizeOpenCodeEvent({ type: "text", part: { text: "Done" } })).toMatchObject({
      output: "Done",
      event: { type: "AGENT_OUTPUT", message: "Done" },
    });
    expect(normalizeOpenCodeEvent({
      type: "tool_use",
      part: { tool: "bash", callID: "call-1", state: { status: "running" } },
    })).toMatchObject({ event: { type: "TOOL_STARTED", tool: "bash" } });
    expect(normalizeOpenCodeEvent({ type: "step_finish" })).toMatchObject({
      event: { type: "SESSION_COMPLETED" },
    });
  });

  test("surfaces the real message from nested provider errors", () => {
    expect(normalizeOpenCodeEvent({
      type: "error",
      error: { name: "UnknownError", data: { message: "Model not found: deepseek/deepseek-v4-flash." } },
    })).toMatchObject({ event: { type: "SESSION_FAILED", message: "Model not found: deepseek/deepseek-v4-flash." } });
    expect(normalizeOpenCodeEvent({ type: "error", message: "quota exceeded" })).toMatchObject({
      event: { type: "SESSION_FAILED", message: "quota exceeded" },
    });
    expect(normalizeOpenCodeEvent({ type: "error", error: {} })).toMatchObject({
      event: { type: "SESSION_FAILED", message: "OpenCode session failed" },
    });
  });

  test("surfaces a session error event even when the CLI exits zero", async () => {
    const original = Bun.spawn;
    const events: AgentEvent[] = [];
    const request: AgentRequest = {
      role: "issue-worker",
      workingDirectory: "/work/repository",
      task: "Implement issue #12",
      context: "Base commit abc123",
      model: "test-model",
      onEvent: (event) => { events.push(event); },
    };
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(JSON.stringify({
          type: "error",
          error: { name: "UnknownError", data: { message: "Model not found: test-model." } },
        }) + "\n"));
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const fake = mock((_args: unknown) => ({
      stdin: { write() {}, end() {} },
      stdout,
      stderr,
      exited: Promise.resolve(0),
      kill() {},
    }));
    // @ts-expect-error test-only substitution of the spawn implementation
    Bun.spawn = fake;
    try {
      const result = await new OpenCodeProvider().execute(request);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Model not found: test-model.");
      expect(events.some((event) => event.type === "SESSION_FAILED" && event.message === "Model not found: test-model."))
        .toBe(true);
    } finally {
      Bun.spawn = original;
    }
  });

});

test("redacts configured credentials from provider output", () => {
  expect(redactSecrets(
    "request failed for secret-token and postgres://user:pass@db/app",
    { GITHUB_TOKEN: "secret-token", DATABASE_URL: "postgres://user:pass@db/app", PUBLIC_NAME: "keep" },
  )).toBe("request failed for [REDACTED] and [REDACTED]");
});

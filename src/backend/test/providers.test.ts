import { describe, expect, mock, test } from "bun:test";
import { buildCodexCommand, CodexProvider, normalizeCodexEvent } from "../src/providers/codex.ts";
import {
  buildOpenCodeCommand, normalizeOpenCodeEvent, openCodeEnvironment, OpenCodeProvider,
} from "../src/providers/opencode.ts";
import { redactSecrets } from "../src/core/secrets.ts";
import { parseConfig } from "../src/core/config-schema.ts";
import { ProviderProcessError, runJsonlProcess } from "../src/providers/process.ts";
import { agentProfileForJobType, configuredAgent } from "../src/providers/index.ts";
import { buildAgentPrompt, type AgentEvent, type AgentRequest, type AgentTokenUsage } from "../src/providers/types.ts";
import type { ProviderUsageSnapshot } from "../src/providers/types.ts";

const request: AgentRequest = {
  role: "issue-worker",
  workingDirectory: "/work/repository",
  task: "Implement issue #12",
  context: "Base commit abc123",
  model: "test-model",
  reasoningEffort: "max",
};

const configured = parseConfig({
  DATABASE_URL: "postgresql://worker:worker@localhost:17432/swarmloom",
  REDIS_URL: "redis://localhost:18422",
  SETTINGS_ENCRYPTION_KEY: "test-settings-encryption-key-0123456789",
  GITHUB_TOKEN: "test-token",
  GITHUB_REPOSITORIES: "acme/api",
  AGENT_PROVIDER: "codex",
  CODEX_CODING_MODEL: "gpt-6.1-sol",
  CODEX_REVIEW_MODEL: "gpt-6-astra",
  CODEX_CODING_REASONING_EFFORT: "low",
  CODEX_REVIEW_REASONING_EFFORT: "high",
});
const configuredOpenCode = parseConfig({
  DATABASE_URL: "postgresql://worker:worker@localhost:17432/swarmloom",
  REDIS_URL: "redis://localhost:18422",
  SETTINGS_ENCRYPTION_KEY: "test-settings-encryption-key-0123456789",
  GITHUB_TOKEN: "test-token",
  GITHUB_REPOSITORIES: "acme/api",
  AGENT_PROVIDER: "opencode",
  OPENCODE_CODING_MODEL: "opencode-go/coding-model",
  OPENCODE_REVIEW_MODEL: "opencode-go/review-model",
});

test("resolves explicit coding and review profiles for every job type", () => {
  expect(configuredAgent(configured, "coding")).toMatchObject({
    provider: "CODEX",
    model: "gpt-6.1-sol",
    reasoningEffort: "low",
  });
  expect(configuredAgent(configured, "review")).toMatchObject({
    provider: "CODEX",
    model: "gpt-6-astra",
    reasoningEffort: "high",
  });
  expect(([
    "IMPLEMENTATION", "FIX", "REVIEW",
  ] as const).map(agentProfileForJobType)).toEqual(["coding", "coding", "review"]);
  expect(configuredAgent(configuredOpenCode, "coding")).toMatchObject({
    provider: "OPENCODE",
    model: "opencode-go/coding-model",
    reasoningEffort: undefined,
  });
  expect(configuredAgent(configuredOpenCode, "review")).toMatchObject({
    provider: "OPENCODE",
    model: "opencode-go/review-model",
    reasoningEffort: undefined,
  });
});

describe("Codex provider", () => {
  test("builds a fresh, noninteractive command", () => {
    expect(buildCodexCommand(request)).toEqual([
      "codex", "exec", "--json", "--ignore-user-config", "--model", "test-model",
      "--dangerously-bypass-approvals-and-sandbox", "--config",
      'model_reasoning_effort="max"', "--cd", "/work/repository", "-",
    ]);
  });

  test("builds a noninteractive command that resumes the requested session", () => {
    expect(buildCodexCommand({ ...request, resumeSessionId: "thread-1" })).toEqual([
      "codex", "exec", "resume", "thread-1", "--json", "--ignore-user-config", "--model", "test-model",
      "--dangerously-bypass-approvals-and-sandbox", "--config", 'model_reasoning_effort="max"', "-",
    ]);
  });

  test("stops when a requested resume starts a different session", async () => {
    const original = Bun.spawn;
    const events: AgentEvent[] = [];
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          { type: "thread.started", thread_id: "other-thread" },
          { type: "item.completed", item: { type: "agent_message", text: "must not run" } },
        ].map((value) => JSON.stringify(value)).join("\n") + "\n"));
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    let spawned: { args: unknown; options: unknown } | undefined;
    let killed = false;
    const fake = mock((args: unknown, options: unknown) => {
      spawned = { args, options };
      return {
        stdin: { write() {}, end() {} },
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill() { killed = true; },
      };
    });
    // @ts-expect-error test-only substitution of the spawn implementation
    Bun.spawn = fake;
    try {
      const result = await new CodexProvider().execute({
        ...request,
        resumeSessionId: "thread-1",
        onEvent: (event) => { events.push(event); },
      });
      expect(killed).toBe(true);
      expect(spawned).toMatchObject({
        args: ["codex", "exec", "resume", "thread-1", "--json", "--ignore-user-config", "--model", "test-model", "--dangerously-bypass-approvals-and-sandbox", "--config", 'model_reasoning_effort="max"', "-"],
        options: { cwd: "/work/repository" },
      });
      expect(result).toMatchObject({ sessionId: null, exitCode: 1, stderr: expect.stringContaining("requested thread-1") });
      expect(events).toEqual([expect.objectContaining({ type: "SESSION_FAILED" })]);
    } finally {
      Bun.spawn = original;
    }
  });

  test("does not classify a missing resumed session as quota exhaustion", async () => {
    const original = Bun.spawn;
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("usage limit while resuming"));
        controller.close();
      },
    });
    const fake = mock((_args: unknown, _options: unknown) => ({
      stdin: { write() {}, end() {} },
      stdout,
      stderr,
      exited: Promise.resolve(1),
      kill() {},
    }));
    const exhausted: ProviderUsageSnapshot = {
      status: "available",
      availability: "exhausted",
      spendControlReached: null,
      rateLimitReachedType: null,
      observedAt: "2026-08-29T20:00:00.000Z",
      windows: [{
        limitId: "codex",
        limitName: "included",
        windowType: "primary",
        usedPercent: 100,
        remainingPercent: 0,
        windowDurationMins: 300,
        resetsAt: "2026-08-29T21:00:00.000Z",
      }],
    };
    // @ts-expect-error test-only substitution of the spawn implementation
    Bun.spawn = fake;
    try {
      const result = await new CodexProvider({
        readAccountUsage: async () => exhausted,
        refreshAccountUsage: async () => exhausted,
      }).execute({
        ...request,
        resumeSessionId: "missing-thread",
      });
      expect(result.failure).toBeUndefined();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("missing-thread");
      expect(result.stderr).toContain("usage limit while resuming");
    } finally {
      Bun.spawn = original;
    }
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

  test("forwards provider-reported cumulative token usage", async () => {
    const original = Bun.spawn;
    const usage: AgentTokenUsage[] = [];
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`${JSON.stringify({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              total: {
                inputTokens: 1_000,
                cachedInputTokens: 400,
                outputTokens: 120,
                reasoningOutputTokens: 80,
                totalTokens: 1_120,
              },
            },
          },
        })}\n`));
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
      const result = await new CodexProvider().execute({
        ...request,
        onUsage: (value) => { usage.push(value); },
      });
      expect(usage).toEqual([{
        inputTokens: 1_000n,
        cachedInputTokens: 400n,
        outputTokens: 120n,
        reasoningOutputTokens: 80n,
        totalTokens: 1_120n,
      }]);
      expect(result.usage).toEqual(usage[0]);
    } finally {
      Bun.spawn = original;
    }
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

  test("redacts request-scoped credentials from output", async () => {
    const original = Bun.spawn;
    const credential = "AUTHORIZATION: basic derived-credential";
    const events: AgentEvent[] = [];
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: `leaked ${credential}` },
        })}\n`));
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
      const result = await new CodexProvider().execute({
        ...request,
        environment: { GIT_CONFIG_VALUE_0: credential },
        onEvent: (event) => { events.push(event); },
      });
      expect(result.finalOutput).toBe("leaked [REDACTED]");
      expect(events[0]?.message).toBe("leaked [REDACTED]");
    } finally {
      Bun.spawn = original;
    }
  });

  test("classifies a mixed quota failure from the refreshed structured snapshot", async () => {
    const original = Bun.spawn;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({
          type: "turn.failed",
          error: { message: "apply_patch verification failed" },
        })}\n`));
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("You've hit your usage limit; try again at 7:00 PM."));
        controller.close();
      },
    });
    const fake = mock((_args: unknown) => ({
      stdin: { write() {}, end() {} },
      stdout,
      stderr,
      exited: Promise.resolve(1),
      kill() {},
    }));
    const exhausted: ProviderUsageSnapshot = {
      status: "available",
      availability: "exhausted",
      spendControlReached: null,
      rateLimitReachedType: null,
      observedAt: "2026-08-29T20:00:00.000Z",
      windows: [{
        limitId: "codex",
        limitName: "included",
        windowType: "primary",
        usedPercent: 100,
        remainingPercent: 0,
        windowDurationMins: 300,
        resetsAt: "2026-08-29T21:00:00.000Z",
      }],
    };
    // @ts-expect-error test-only substitution of the spawn implementation
    Bun.spawn = fake;
    try {
      const result = await new CodexProvider({
        readAccountUsage: async () => ({ ...exhausted, availability: "available" }),
        refreshAccountUsage: async () => exhausted,
      }).execute(request);
      expect(result.failure).toMatchObject({ reason: "QUOTA_EXHAUSTED", quota: exhausted });
      expect(result.stderr).toContain("usage limit");
      expect(result.stderr).toContain("apply_patch verification failed");
    } finally {
      Bun.spawn = original;
    }
  });

  test("keeps an ambiguous failure terminal when refreshed quota is available", async () => {
    const original = Bun.spawn;
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("usage limit text from an unrelated provider error"));
        controller.close();
      },
    });
    const fake = mock((_args: unknown) => ({
      stdin: { write() {}, end() {} },
      stdout,
      stderr,
      exited: Promise.resolve(1),
      kill() {},
    }));
    const available: ProviderUsageSnapshot = {
      status: "available",
      availability: "available",
      spendControlReached: null,
      rateLimitReachedType: null,
      observedAt: "2026-08-29T20:00:00.000Z",
      windows: [],
    };
    // @ts-expect-error test-only substitution of the spawn implementation
    Bun.spawn = fake;
    try {
      const result = await new CodexProvider({
        readAccountUsage: async () => available,
        refreshAccountUsage: async () => available,
      }).execute(request);
      expect(result.failure).toBeUndefined();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("usage limit text");
    } finally {
      Bun.spawn = original;
    }
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

test("injects the response file contract into the shared prompt", () => {
  const prompt = buildAgentPrompt({ ...request, responseFilePath: "/data/outcomes/job-issue-worker.txt" });
  expect(prompt).toContain("Response file: /data/outcomes/job-issue-worker.txt");
  expect(prompt).toContain("Role: issue-worker");
  expect(prompt).not.toContain("Result file");
});

test("preserves exit code and sanitized stderr when the provider emits invalid JSONL", async () => {
  const original = Bun.spawn;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('{"valid":true}\nnot-json\n'));
      controller.close();
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode("secret-token leaked in stderr"));
      controller.close();
    },
  });
  const fake = mock((_args: unknown) => ({
    stdin: { write() {}, end() {} },
    stdout,
    stderr,
    exited: Promise.resolve(3),
    kill() {},
  }));
  // @ts-expect-error test-only substitution of the spawn implementation
  Bun.spawn = fake;
  try {
    const parsed: string[] = [];
    let thrown: unknown;
    try {
      await runJsonlProcess(["provider", "run"], "", undefined, async (value) => {
        parsed.push((value as { valid: boolean }).valid ? "ok" : "bad");
      }, { GITHUB_TOKEN: "secret-token" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderProcessError);
    expect(thrown).toMatchObject({
      name: "ProviderProcessError",
      exitCode: 3,
      stderr: "[REDACTED] leaked in stderr",
    });
    expect(parsed).toEqual(["ok"]);
  } finally {
    Bun.spawn = original;
  }
});

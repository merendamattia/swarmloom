import { describe, expect, test } from "bun:test";
import {
  createCodexUsageReader,
  normalizeCodexRateLimits,
  normalizeCodexTokenUsage,
  readCodexRateLimits,
  readCodexThreadUsage,
} from "../src/providers/codex-usage.ts";
import { normalizeCodexEvent } from "../src/providers/codex.ts";
import { quotaAdmission } from "../src/providers/quota.ts";

describe("Codex account usage", () => {
  test("normalizes five-hour and weekly windows without assuming a model mapping", () => {
    const snapshot = normalizeCodexRateLimits({
      result: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex included usage",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 62, windowDurationMins: 10_080, resetsAt: null },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 62, windowDurationMins: 10_080, resetsAt: null },
          },
          "model-specific": {
            primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 1_800_000_100 },
          },
        },
      },
    }, new Date("2026-08-29T20:00:00.000Z"));

    expect(snapshot).toMatchObject({
      status: "available",
      observedAt: "2026-08-29T20:00:00.000Z",
      windows: [
        {
          limitId: "codex",
          windowType: "primary",
          usedPercent: 25,
          remainingPercent: 75,
          windowDurationMins: 300,
          resetsAt: "2027-01-15T08:00:00.000Z",
        },
        {
          limitId: "codex",
          windowType: "secondary",
          usedPercent: 62,
          remainingPercent: 38,
          windowDurationMins: 10_080,
          resetsAt: null,
        },
      ],
    });
  });

  test("keeps unavailable quota fields unknown", () => {
    const snapshot = normalizeCodexRateLimits({
      result: {
        rateLimits: {
          primary: { usedPercent: 100, windowDurationMins: null, resetsAt: null },
          secondary: null,
        },
      },
    });

    expect(snapshot.windows).toEqual([{
      limitId: null,
      limitName: null,
      windowType: "primary",
      usedPercent: 100,
      remainingPercent: 0,
      windowDurationMins: null,
      resetsAt: null,
    }]);
  });

  test("normalizes explicit exhaustion even when window percentages are non-zero or unknown", () => {
    const snapshot = normalizeCodexRateLimits({
      result: {
        rateLimits: {
          spendControlReached: true,
          rateLimitReachedType: "workspaceMemberUsageLimitReached",
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
          secondary: { usedPercent: null, windowDurationMins: 10_080, resetsAt: null },
        },
      },
    });

    expect(snapshot).toMatchObject({
      status: "available",
      availability: "exhausted",
      spendControlReached: true,
      rateLimitReachedType: "workspaceMemberUsageLimitReached",
    });
  });

  test("coalesces concurrent account reads and caches a fresh snapshot", async () => {
    let reads = 0;
    const reader = createCodexUsageReader({
      freshnessMs: 1_000,
      read: async () => {
        reads += 1;
        return normalizeCodexRateLimits({ result: { rateLimits: { primary: null, secondary: null } } });
      },
    });

    const [first, second] = await Promise.all([reader.readAccountUsage(), reader.readAccountUsage()]);
    expect(first).toEqual(second);
    expect(reads).toBe(1);
    await reader.readAccountUsage();
    expect(reads).toBe(1);
    await reader.refreshAccountUsage?.();
    expect(reads).toBe(2);
  });

  test("caches unavailable reads for the freshness interval", async () => {
    let reads = 0;
    const reader = createCodexUsageReader({
      freshnessMs: 1_000,
      read: async () => {
        reads += 1;
        throw new Error("Codex unavailable");
      },
    });

    expect((await reader.readAccountUsage()).status).toBe("unavailable");
    expect((await reader.readAccountUsage()).status).toBe("unavailable");
    expect(reads).toBe(1);
  });

  test("uses replay-capable resume to read restored thread usage", async () => {
    const original = Bun.spawn;
    const requests: Array<{ id?: number; method?: string; params?: { threadId?: string; excludeTurns?: boolean } }> = [];
    const fakeSpawn = () => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let closed = false;
      const encoder = new TextEncoder();
      const stdout = new ReadableStream<Uint8Array>({
        start(next) { controller = next; },
      });
      const send = (message: unknown) => controller?.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
      const stdin = {
        write(value: string) {
          const request = JSON.parse(value) as { id?: number; method?: string; params?: { threadId?: string; excludeTurns?: boolean } };
          requests.push(request);
          if (request.id === 1) send({ id: 1, result: {} });
          if (request.method === "account/rateLimits/read") {
            send({ id: 2, result: { rateLimits: {
              primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
              secondary: { usedPercent: 62, windowDurationMins: 10_080, resetsAt: null },
            } } });
          }
          if (request.method === "thread/resume") {
            send({ id: 3, result: { thread: { id: "thread-1" } } });
            if (!request.params?.excludeTurns) {
              send({ method: "thread/tokenUsage/updated", params: {
                threadId: "thread-1",
                turnId: "turn-1",
                tokenUsage: { total: {
                  inputTokens: 1_000,
                  cachedInputTokens: 400,
                  outputTokens: 120,
                  reasoningOutputTokens: 80,
                  totalTokens: 1_120,
                } },
              } });
            }
          }
        },
      };
      return {
        stdin,
        stdout,
        stderr: new ReadableStream<Uint8Array>({ start(next) { next.close(); } }),
        exited: Promise.resolve(0),
        kill() {
          if (closed) return;
          closed = true;
          controller?.close();
        },
      };
    };
    // @ts-expect-error test-only substitution of the spawn implementation
    Bun.spawn = fakeSpawn;
    try {
      const account = await readCodexRateLimits();
      expect(account.windows.map(({ windowDurationMins, remainingPercent }) => ({ windowDurationMins, remainingPercent })))
        .toEqual([{ windowDurationMins: 300, remainingPercent: 75 }, { windowDurationMins: 10_080, remainingPercent: 38 }]);
      expect(await readCodexThreadUsage("thread-1")).toEqual({
        inputTokens: 1_000n,
        cachedInputTokens: 400n,
        outputTokens: 120n,
        reasoningOutputTokens: 80n,
        totalTokens: 1_120n,
      });
      expect(requests.find(({ method }) => method === "thread/resume")?.params).toEqual({ threadId: "thread-1" });
      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 1, method: "initialize" }),
        expect.objectContaining({ id: 2, method: "account/rateLimits/read" }),
        expect.objectContaining({ id: 3, method: "thread/resume" }),
      ]));
    } finally {
      Bun.spawn = original;
    }
  });

  test("does not expose additional limit buckets without an applicable mapping", () => {
    const snapshot = normalizeCodexRateLimits({
      result: {
        rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null } },
        rateLimitsByLimitId: {
          "model-specific": { primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: null } },
        },
      },
    });

    expect(snapshot.windows).toEqual([
      expect.objectContaining({ limitId: null, windowDurationMins: 300, remainingPercent: 60 }),
    ]);
  });

  test("does not let an exhausted unmapped bucket block a healthy root allowance", () => {
    const snapshot = normalizeCodexRateLimits({
      result: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
          },
          "model-specific": {
            rateLimitReachedType: "unmappedModelLimitReached",
            primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: null },
          },
        },
      },
    });

    expect(snapshot.availability).toBe("available");
    expect(quotaAdmission(snapshot)).toEqual({ kind: "allow" });
  });
});

test("accepts provider int64 token counts without narrowing them to 32-bit integers", () => {
  expect(normalizeCodexTokenUsage({
    inputTokens: "9223372036854775807",
    cachedInputTokens: "9223372036854775806",
    outputTokens: 2_147_483_648,
    reasoningOutputTokens: null,
    totalTokens: "9223372036854775807",
  })).toEqual({
    inputTokens: BigInt("9223372036854775807"),
    cachedInputTokens: BigInt("9223372036854775806"),
    outputTokens: BigInt("2147483648"),
    reasoningOutputTokens: null,
    totalTokens: BigInt("9223372036854775807"),
  });
  expect(normalizeCodexTokenUsage({ inputTokens: -1n })).toEqual({
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
  });
});

test("normalizes cumulative Codex thread token usage notifications", () => {
  const normalized = normalizeCodexEvent({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-2",
      tokenUsage: {
        total: {
          inputTokens: 1_000,
          cachedInputTokens: 400,
          outputTokens: 120,
          reasoningOutputTokens: 80,
          totalTokens: 1_120,
        },
        last: {
          inputTokens: 200,
          cachedInputTokens: 100,
          outputTokens: 40,
          reasoningOutputTokens: 20,
          totalTokens: 240,
        },
      },
    },
  });

  expect(normalized).toMatchObject({
    usage: {
      inputTokens: 1_000n,
      cachedInputTokens: 400n,
      outputTokens: 120n,
      reasoningOutputTokens: 80n,
      totalTokens: 1_120n,
    },
  });
});

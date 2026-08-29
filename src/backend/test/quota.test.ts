import { describe, expect, test } from "bun:test";
import { createCodexUsageReader, normalizeCodexRateLimits } from "../src/providers/codex-usage.ts";
import { quotaAdmission, quotaAvailable } from "../src/providers/quota.ts";
import type { ProviderUsageSnapshot } from "../src/providers/types.ts";

const snapshot = (overrides: Partial<ProviderUsageSnapshot> = {}): ProviderUsageSnapshot => ({
  status: "available",
  availability: "unknown",
  observedAt: "2026-08-29T20:00:00.000Z",
  windows: [],
  ...overrides,
});

describe("provider quota admission", () => {
  test("waits on a confirmed exhausted allowance and keeps safe reset metadata", () => {
    expect(quotaAdmission(snapshot({
      availability: "exhausted",
      windows: [{
        limitId: "codex",
        limitName: "Codex included usage",
        windowType: "primary",
        usedPercent: 100,
        remainingPercent: 0,
        windowDurationMins: 300,
        resetsAt: "2026-08-29T21:00:00.000Z",
      }],
    }))).toEqual({
      kind: "wait",
      resetAt: "2026-08-29T21:00:00.000Z",
      window: "codex:primary",
      usedPercent: 100,
    });
  });

  test("does not block when quota telemetry is unknown or unavailable", () => {
    expect(quotaAdmission(snapshot())).toEqual({ kind: "allow" });
    expect(quotaAdmission(snapshot({ status: "unavailable" }))).toEqual({ kind: "allow" });
    expect(quotaAdmission(snapshot({ status: "stale", availability: "exhausted" }))).toEqual({ kind: "allow" });
    expect(quotaAdmission(snapshot({ status: "unsupported", availability: "exhausted" }))).toEqual({ kind: "allow" });
  });

  test("normalizes Codex usage windows without assuming a plan allowance", () => {
    const result = normalizeCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_756_506_000 },
        secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_756_800_000 },
      },
      rateLimitsByLimitId: {
        flex: { limitId: "flex", primary: { usedPercent: 0 } },
      },
    }, new Date("2026-08-29T20:00:00.000Z"));

    expect(result).toMatchObject({ status: "available", availability: "exhausted", observedAt: "2026-08-29T20:00:00.000Z" });
    expect(result.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ limitId: "codex", windowType: "primary", usedPercent: 100, remainingPercent: 0 }),
      expect.objectContaining({ limitId: "flex", windowType: "primary", usedPercent: 0, remainingPercent: 100 }),
    ]));
    expect(quotaAdmission(result).kind).toBe("wait");
  });

  test("uses limit-map windows when the account snapshot omits a root rate limit", () => {
    const result = normalizeCodexRateLimits({
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 100, resetsAt: 1_756_506_000 } },
      },
    });

    expect(result.availability).toBe("exhausted");
    expect(quotaAdmission(result).kind).toBe("wait");
  });

  test("coalesces concurrent account reads and only releases known available quota", async () => {
    let reads = 0;
    const reader = createCodexUsageReader({
      read: async () => {
        reads += 1;
        await Bun.sleep(1);
        return snapshot({ availability: "available" });
      },
    });

    const results = await Promise.all([
      reader.readAccountUsage(),
      reader.readAccountUsage(),
      reader.readAccountUsage(),
    ]);
    expect(reads).toBe(1);
    expect(results.every((value) => quotaAvailable(value))).toBe(true);
    expect(quotaAvailable(snapshot({ status: "unavailable", availability: "unknown" }))).toBe(false);
  });
});

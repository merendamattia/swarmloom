import { describe, expect, test } from "bun:test";
import { buildHealthServices, heartbeatServiceState } from "../src/api/health.ts";

describe("heartbeatServiceState", () => {
  test("reports healthy while the heartbeat is fresh", () => {
    const lastSeenAt = new Date(Date.now() - 1_000);
    expect(heartbeatServiceState({ lastSeenAt }, 60_000, Date.now())).toEqual({
      state: "healthy",
      detail: "Heartbeat confirmed",
      lastSeenAt: lastSeenAt.toISOString(),
    });
  });

  test("reports offline once the heartbeat is stale", () => {
    const lastSeenAt = new Date(Date.now() - 120_000);
    expect(heartbeatServiceState({ lastSeenAt }, 60_000, Date.now())).toEqual({
      state: "offline",
      detail: "Heartbeat expired",
      lastSeenAt: lastSeenAt.toISOString(),
    });
  });

  test("reports unavailable before any heartbeat is recorded", () => {
    expect(heartbeatServiceState(null, 60_000, Date.now())).toEqual({
      state: "unavailable",
      detail: "No heartbeat recorded",
      lastSeenAt: null,
    });
  });
});

describe("buildHealthServices", () => {
  const now = Date.now();
  const fresh = { lastSeenAt: new Date(now - 1_000) };

  test("resolves every service even when the database probe fails", () => {
    expect(buildHealthServices({
      api: fresh,
      worker: null,
      databaseOk: false,
      queueOk: true,
      staleThresholdMs: 60_000,
    })).toMatchObject({
      api: { state: "healthy" },
      worker: { state: "unavailable" },
      database: { state: "offline", detail: "Unreachable" },
      queue: { state: "healthy" },
      scheduler: { state: "healthy" },
    });
  });

  test("ties the scheduler to the API process heartbeat", () => {
    expect(buildHealthServices({
      api: null,
      worker: fresh,
      databaseOk: true,
      queueOk: true,
      staleThresholdMs: 60_000,
    }).scheduler).toEqual({
      state: "unavailable",
      detail: "No heartbeat recorded",
      lastSeenAt: null,
    });
  });
});

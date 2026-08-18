import { describe, expect, test } from "bun:test";
import { heartbeatServiceState } from "../src/api/health.ts";

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

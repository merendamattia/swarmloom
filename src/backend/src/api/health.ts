export type ServiceState = {
  state: "healthy" | "offline" | "unavailable";
  detail: string;
  lastSeenAt: string | null;
};

export type Heartbeat = { lastSeenAt: Date } | null;

export function heartbeatServiceState(
  heartbeat: Heartbeat,
  staleThresholdMs: number,
  now = Date.now(),
): ServiceState {
  if (!heartbeat) return { state: "unavailable", detail: "No heartbeat recorded", lastSeenAt: null };
  const lastSeenAt = heartbeat.lastSeenAt.toISOString();
  if (heartbeat.lastSeenAt.getTime() <= now - staleThresholdMs) {
    return { state: "offline", detail: "Heartbeat expired", lastSeenAt };
  }
  return { state: "healthy", detail: "Heartbeat confirmed", lastSeenAt };
}

export function buildHealthServices({
  api,
  worker,
  databaseOk,
  queueOk,
  staleThresholdMs,
}: {
  api: Heartbeat;
  worker: Heartbeat;
  databaseOk: boolean;
  queueOk: boolean;
  staleThresholdMs: number;
}): Record<string, ServiceState> {
  const apiState = heartbeatServiceState(api, staleThresholdMs);
  return {
    api: apiState,
    worker: heartbeatServiceState(worker, staleThresholdMs),
    database: databaseOk
      ? { state: "healthy", detail: "ok", lastSeenAt: null }
      : { state: "offline", detail: "Unreachable", lastSeenAt: null },
    queue: queueOk
      ? { state: "healthy", detail: "ok", lastSeenAt: null }
      : { state: "offline", detail: "Unreachable", lastSeenAt: null },
    scheduler: apiState,
  };
}

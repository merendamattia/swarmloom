export type ServiceState = {
  state: "healthy" | "offline" | "unavailable";
  detail: string;
  lastSeenAt: string | null;
};

export function heartbeatServiceState(
  heartbeat: { lastSeenAt: Date } | null,
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

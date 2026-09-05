import { providerEnvironment, readLines } from "./process.ts";
import type { ProviderQuotaWindow, ProviderUsageCapability, ProviderUsageSnapshot } from "./types.ts";

const ACCOUNT_RATE_LIMIT_REQUEST_ID = 2;
const DEFAULT_FRESHNESS_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function field(value: RecordValue, ...names: string[]) {
  for (const name of names) {
    if (Object.hasOwn(value, name)) return value[name];
  }
  return undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function percentValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function durationValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function resetValue(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const reset = new Date(value * 1_000);
  return Number.isNaN(reset.getTime()) ? null : reset.toISOString();
}

function normalizeWindow(
  source: RecordValue,
  windowType: ProviderQuotaWindow["windowType"],
  limitId: string | null,
  limitName: string | null,
): ProviderQuotaWindow {
  const reportedUsedPercent = percentValue(field(source, "usedPercent", "used_percent"));
  const reportedRemainingPercent = percentValue(field(source, "remainingPercent", "remaining_percent"));
  const usedPercent = reportedUsedPercent ?? (reportedRemainingPercent === null ? null : 100 - reportedRemainingPercent);
  return {
    limitId,
    limitName,
    windowType,
    usedPercent,
    remainingPercent: reportedRemainingPercent ?? (usedPercent === null ? null : 100 - usedPercent),
    windowDurationMins: durationValue(field(source, "windowDurationMins", "window_duration_mins", "windowMinutes")),
    resetsAt: resetValue(field(source, "resetsAt", "resets_at")),
  };
}

function windowsForSnapshot(source: RecordValue, fallbackLimitId: string | null): ProviderQuotaWindow[] {
  const snapshot = record(field(source, "rateLimits", "rate_limits")) ?? source;
  const limitId = stringValue(field(snapshot, "limitId", "limit_id")) ?? fallbackLimitId;
  const limitName = stringValue(field(snapshot, "limitName", "limit_name"));
  return (["primary", "secondary"] as const).flatMap((windowType) => {
    const window = record(field(snapshot, windowType));
    return window ? [normalizeWindow(window, windowType, limitId, limitName)] : [];
  });
}

function unavailableSnapshot(message = "Codex quota telemetry is unavailable"): ProviderUsageSnapshot {
  return { status: "unavailable", availability: "unknown", observedAt: null, windows: [], message };
}

function unknownSnapshot(observedAt: Date, message: string): ProviderUsageSnapshot {
  return { status: "available", availability: "unknown", observedAt: observedAt.toISOString(), windows: [], message };
}

function rootAvailability(
  windows: ProviderQuotaWindow[],
  source: RecordValue | undefined,
): ProviderUsageSnapshot["availability"] {
  const exhausted = source && (stringValue(field(source, "rateLimitReachedType", "rate_limit_reached_type"))
    || field(source, "spendControlReached", "spend_control_reached") === true);
  if (exhausted || windows.some(({ remainingPercent }) => remainingPercent === 0)) {
    return "exhausted";
  }
  if (windows.some(({ remainingPercent }) => remainingPercent !== null)) return "available";
  return "unknown";
}

export function normalizeCodexRateLimits(value: unknown, observedAt = new Date()): ProviderUsageSnapshot {
  const root = record(value);
  const result = record(root?.result) ?? root;
  if (!result) return unavailableSnapshot("Codex returned an invalid quota snapshot");

  const rateLimits = record(field(result, "rateLimits", "rate_limits"));
  const byLimitId = record(field(result, "rateLimitsByLimitId", "rate_limits_by_limit_id"));
  const mappedEntries = byLimitId ? Object.entries(byLimitId) : [];
  const rootLimitId = rateLimits ? stringValue(field(rateLimits, "limitId", "limit_id")) : null;
  if (!rateLimits) {
    return unknownSnapshot(
      observedAt,
      mappedEntries.length > 0
        ? "Codex reported quota buckets without a reliable applicable mapping"
        : "Codex did not report any quota windows",
    );
  }
  const entries = [[rootLimitId, rateLimits] as const];

  const windows = entries.flatMap(([limitId, source]) => windowsForSnapshot(
    record(source) ?? {},
    stringValue(limitId),
  ));
  return {
    status: "available",
    availability: rootAvailability(windows, record(entries[0]?.[1]) ?? undefined),
    observedAt: observedAt.toISOString(),
    windows,
  };
}

type CodexUsageReaderOptions = {
  freshnessMs?: number;
  read?: () => Promise<ProviderUsageSnapshot>;
};

export type CodexUsageReader = ProviderUsageCapability;

export function createCodexUsageReader(options: CodexUsageReaderOptions = {}): CodexUsageReader {
  const freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const read = options.read ?? readCodexRateLimits;
  let cached: { snapshot: ProviderUsageSnapshot; expiresAt: number } | undefined;
  let pending: Promise<ProviderUsageSnapshot> | undefined;

  const readFresh = () => {
    if (pending) return pending;
    pending = read().then((snapshot) => {
      cached = { snapshot, expiresAt: Date.now() + freshnessMs };
      return snapshot;
    }).catch(() => {
      const snapshot: ProviderUsageSnapshot = cached
        ? { ...cached.snapshot, status: "stale", availability: "unknown", message: "The last Codex quota snapshot may be out of date" }
        : unavailableSnapshot();
      cached = { snapshot, expiresAt: Date.now() + freshnessMs };
      return snapshot;
    }).finally(() => {
      pending = undefined;
    });
    return pending;
  };

  return {
    readAccountUsage: async () => {
      if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
      return readFresh();
    },
    refreshAccountUsage: readFresh,
  };
}

type JsonRpcWaiter = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type CodexAppServerClient = {
  request(message: RecordValue): void;
  waitFor(id: number): Promise<unknown>;
};

async function withCodexAppServer<T>(operation: (client: CodexAppServerClient) => Promise<T>) {
  const child = Bun.spawn(["codex", "app-server", "--listen", "stdio://"], {
    env: providerEnvironment(globalThis.process.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const waiters = new Map<number, JsonRpcWaiter>();
  const responses = new Map<number, { error: boolean; result: unknown }>();
  const stderr = new Response(child.stderr).text();
  const output = readLines(child.stdout, async (line) => {
    let message: RecordValue | undefined;
    try {
      message = record(JSON.parse(line));
    } catch {
      return;
    }
    if (!message) return;
    const id = message.id;
    if (typeof id !== "number") return;
    const waiter = waiters.get(id);
    const response = { error: Boolean(record(message.error)), result: message.result };
    if (!waiter) {
      responses.set(id, response);
      return;
    }
    waiters.delete(id);
    if (response.error) waiter.reject(new Error("Codex App Server request failed"));
    else waiter.resolve(response.result);
  });

  const waitFor = (id: number) => {
    const response = responses.get(id);
    if (response) {
      responses.delete(id);
      return response.error
        ? Promise.reject(new Error("Codex App Server request failed"))
        : Promise.resolve(response.result);
    }
    return new Promise<unknown>((resolve, reject) => {
      waiters.set(id, { resolve, reject });
    });
  };
  const request = (message: RecordValue) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const timeout = setTimeout(() => {
    for (const waiter of waiters.values()) waiter.reject(new Error("Codex App Server request timed out"));
    child.kill();
  }, REQUEST_TIMEOUT_MS);

  try {
    const initialized = waitFor(1);
    request({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "swarmloom", title: "Swarmloom", version: "0.1.0" } },
    });
    await initialized;
    request({ method: "initialized", params: {} });
    return await operation({ request, waitFor });
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    await Promise.allSettled([output, stderr]);
    for (const waiter of waiters.values()) waiter.reject(new Error("Codex account quota request ended"));
  }
}

export async function readCodexRateLimits(): Promise<ProviderUsageSnapshot> {
  return withCodexAppServer(async ({ request, waitFor }) => {
    const rateLimits = waitFor(ACCOUNT_RATE_LIMIT_REQUEST_ID);
    request({ id: ACCOUNT_RATE_LIMIT_REQUEST_ID, method: "account/rateLimits/read" });
    return normalizeCodexRateLimits(await rateLimits);
  });
}

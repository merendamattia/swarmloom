import { providerEnvironment, readLines } from "./process.ts";
import type {
  AgentTokenUsage,
  ProviderQuotaWindow,
  ProviderUsageCapability,
  ProviderUsageSnapshot,
} from "./types.ts";

const ACCOUNT_RATE_LIMIT_REQUEST_ID = 2;
const DEFAULT_FRESHNESS_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_INT64 = BigInt("9223372036854775807");

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

function tokenCount(value: unknown) {
  let count: bigint;
  if (typeof value === "bigint") {
    count = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    count = BigInt(value);
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    try {
      count = BigInt(value);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  return count >= BigInt(0) && count <= MAX_INT64 ? count : null;
}

export function normalizeCodexTokenUsage(value: unknown): AgentTokenUsage | null {
  const raw = record(value);
  if (!raw) return null;
  const names = [
    "inputTokens", "input_tokens", "cachedInputTokens", "cached_input_tokens",
    "outputTokens", "output_tokens", "reasoningOutputTokens", "reasoning_output_tokens",
    "totalTokens", "total_tokens",
  ];
  if (!names.some((name) => Object.hasOwn(raw, name))) return null;
  return {
    inputTokens: tokenCount(field(raw, "inputTokens", "input_tokens")),
    cachedInputTokens: tokenCount(field(raw, "cachedInputTokens", "cached_input_tokens")),
    outputTokens: tokenCount(field(raw, "outputTokens", "output_tokens")),
    reasoningOutputTokens: tokenCount(field(raw, "reasoningOutputTokens", "reasoning_output_tokens")),
    totalTokens: tokenCount(field(raw, "totalTokens", "total_tokens")),
  };
}

export function normalizeCodexThreadUsage(value: unknown): AgentTokenUsage | null {
  const raw = record(value);
  if (!raw) return null;
  const params = record(field(raw, "params")) ?? raw;
  const tokenUsage = record(field(params, "tokenUsage", "token_usage"));
  const total = tokenUsage && (record(field(tokenUsage, "total", "totalTokenUsage", "total_token_usage")) ?? tokenUsage);
  return normalizeCodexTokenUsage(total);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
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

function snapshotSource(value: RecordValue) {
  return record(field(value, "rateLimits", "rate_limits")) ?? value;
}

function usageMetadata(source?: RecordValue) {
  if (!source) {
    return { spendControlReached: null, rateLimitReachedType: null };
  }
  const snapshot = snapshotSource(source);
  const spendControlReached = booleanValue(field(snapshot, "spendControlReached", "spend_control_reached"));
  const rateLimitReachedType = stringValue(field(snapshot, "rateLimitReachedType", "rate_limit_reached_type"));
  return {
    spendControlReached,
    rateLimitReachedType,
  };
}

function usageAvailability(
  providerWindows: ProviderQuotaWindow[],
  metadata: ReturnType<typeof usageMetadata>,
): ProviderUsageSnapshot["availability"] {
  if (metadata.spendControlReached === true || metadata.rateLimitReachedType !== null) return "exhausted";
  if (providerWindows.some(({ remainingPercent }) => remainingPercent === 0)) return "exhausted";
  if (providerWindows.some(({ remainingPercent }) => remainingPercent !== null)) return "available";
  return "unknown";
}

function unavailableSnapshot(message = "Codex quota telemetry is unavailable"): ProviderUsageSnapshot {
  return {
    status: "unavailable",
    availability: "unknown",
    spendControlReached: null,
    rateLimitReachedType: null,
    observedAt: null,
    windows: [],
    message,
  };
}

export function normalizeCodexRateLimits(value: unknown, observedAt = new Date()): ProviderUsageSnapshot {
  const root = record(value);
  const result = record(root?.result) ?? root;
  if (!result) return unavailableSnapshot("Codex returned an invalid quota snapshot");

  const rateLimits = record(field(result, "rateLimits", "rate_limits"));
  const byLimitId = record(field(result, "rateLimitsByLimitId", "rate_limits_by_limit_id"));
  const mappedEntries = byLimitId ? Object.entries(byLimitId) : [];
  const rootLimitId = rateLimits ? stringValue(field(rateLimits, "limitId", "limit_id")) : null;
  const rootAlreadyMapped = rootLimitId !== null && mappedEntries.some(([limitId, source]) =>
    limitId === rootLimitId || stringValue(field(record(source) ?? {}, "limitId", "limit_id")) === rootLimitId);
  const entries = [
    ...mappedEntries,
    ...(rateLimits && !rootAlreadyMapped ? [[rootLimitId, rateLimits] as const] : []),
  ];
  if (entries.length === 0) return unavailableSnapshot("Codex did not report any quota windows");

  const windows = entries.flatMap(([limitId, source]) => windowsForSnapshot(
    record(source) ?? {},
    stringValue(limitId),
  ));
  const providerWindows = rateLimits ? windowsForSnapshot(rateLimits, rootLimitId) : [];
  const metadata = usageMetadata(rateLimits);
  return {
    status: "available",
    availability: usageAvailability(providerWindows, metadata),
    ...metadata,
    observedAt: observedAt.toISOString(),
    windows,
  };
}

type CodexUsageReaderOptions = {
  freshnessMs?: number;
  read?: () => Promise<ProviderUsageSnapshot>;
  readThreadUsage?: (threadId: string) => Promise<AgentTokenUsage | null>;
};

export type CodexUsageReader = ProviderUsageCapability;

export function createCodexUsageReader(options: CodexUsageReaderOptions = {}): CodexUsageReader {
  const freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const read = options.read ?? readCodexRateLimits;
  const readThreadUsage = options.readThreadUsage ?? readCodexThreadUsage;
  let cached: { snapshot: ProviderUsageSnapshot; expiresAt: number } | undefined;
  let pending: Promise<ProviderUsageSnapshot> | undefined;

  const readFresh = () => {
    if (pending) return pending;
    pending = read().then((snapshot) => {
      cached = { snapshot, expiresAt: Date.now() + freshnessMs };
      return snapshot;
    }).catch(() => {
      const snapshot = cached
        ? { ...cached.snapshot, status: "stale" as const, message: "The last Codex quota snapshot may be out of date" }
        : unavailableSnapshot();
      cached = { snapshot, expiresAt: Date.now() + freshnessMs };
      return snapshot;
    })
      .finally(() => { pending = undefined; });
    return pending;
  };

  return {
    async readAccountUsage() {
      if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
      return readFresh();
    },
    refreshAccountUsage: readFresh,
    readThreadUsage,
  };
}

type JsonRpcWaiter = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type JsonRpcResponse = { error?: RecordValue; result?: unknown };

type CodexAppServerClient = {
  request(message: RecordValue): void;
  waitFor(id: number): Promise<unknown>;
  subscribe(listener: (message: RecordValue) => void): () => void;
};

const THREAD_USAGE_WAIT_MS = 500;

async function withCodexAppServer<T>(operation: (client: CodexAppServerClient) => Promise<T>) {
  const child = Bun.spawn(["codex", "app-server", "--listen", "stdio://"], {
    env: providerEnvironment(globalThis.process.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const waiters = new Map<number, JsonRpcWaiter>();
  const responses = new Map<number, JsonRpcResponse>();
  const listeners = new Set<(message: RecordValue) => void>();
  const stderr = new Response(child.stderr).text();
  const output = readLines(child.stdout, async (line) => {
    let message: RecordValue | undefined;
    try {
      message = record(JSON.parse(line));
    } catch {
      return;
    }
    if (!message) return;
    const id = message?.id;
    const error = record(message.error);
    if (typeof id === "number") {
      const waiter = waiters.get(id);
      if (!waiter) {
        responses.set(id, { error, result: message.result });
        return;
      }
      waiters.delete(id);
      if (error) {
        waiter.reject(new Error("Codex App Server request failed"));
        return;
      }
      waiter.resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
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
  const subscribe = (listener: (message: RecordValue) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const timeout = setTimeout(() => {
    for (const waiter of waiters.values()) waiter.reject(new Error("Codex App Server request timed out"));
    child.kill();
  }, REQUEST_TIMEOUT_MS);

  try {
    const initialized = waitFor(1);
    request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "swarmloom", title: "Swarmloom", version: "0.1.0" },
      },
    });
    await initialized;
    request({ jsonrpc: "2.0", method: "initialized", params: {} });
    return await operation({ request, waitFor, subscribe });
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
    request({ jsonrpc: "2.0", id: ACCOUNT_RATE_LIMIT_REQUEST_ID, method: "account/rateLimits/read" });
    return normalizeCodexRateLimits(await rateLimits);
  });
}

export async function readCodexThreadUsage(threadId: string): Promise<AgentTokenUsage | null> {
  return withCodexAppServer(async ({ request, waitFor, subscribe }) => {
    let resolveUsage!: (usage: AgentTokenUsage | null) => void;
    const usage = new Promise<AgentTokenUsage | null>((resolve) => { resolveUsage = resolve; });
    const unsubscribe = subscribe((message) => {
      if (message.method !== "thread/tokenUsage/updated") return;
      const normalized = normalizeCodexThreadUsage(message);
      if (normalized) resolveUsage(normalized);
    });
    let noUsageTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const resumed = waitFor(3);
      request({
        jsonrpc: "2.0",
        id: 3,
        method: "thread/resume",
        params: { threadId },
      });
      await resumed;
      const noUsage = new Promise<null>((resolve) => {
        noUsageTimer = setTimeout(() => resolve(null), THREAD_USAGE_WAIT_MS);
      });
      return await Promise.race([
        usage,
        noUsage,
      ]);
    } finally {
      if (noUsageTimer) clearTimeout(noUsageTimer);
      unsubscribe();
    }
  });
}

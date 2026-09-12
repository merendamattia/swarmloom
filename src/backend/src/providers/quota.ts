import type { ProviderUsageSnapshot } from "./types.ts";

export type QuotaAdmission =
  | { kind: "allow" }
  | {
    kind: "wait";
    resetAt: string | null;
    window: string | null;
    usedPercent: number | null;
  };

export function quotaAdmission(snapshot: ProviderUsageSnapshot): QuotaAdmission {
  if (snapshot.status !== "available") return { kind: "allow" };
  if (snapshot.availability !== "exhausted") {
    return { kind: "allow" };
  }

  const exhausted = snapshot.windows.filter(({ remainingPercent, usedPercent }) =>
    remainingPercent === 0 || usedPercent === 100);
  const window = exhausted[0] ?? snapshot.windows[0];
  const resetAt = exhausted
    .map(({ resetsAt }) => resetsAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0]
    ?? snapshot.windows.map(({ resetsAt }) => resetsAt).filter((value): value is string => Boolean(value)).sort()[0]
    ?? null;

  return {
    kind: "wait",
    resetAt,
    window: window ? `${window.limitId ?? "unknown"}:${window.windowType}` : null,
    usedPercent: window?.usedPercent ?? null,
  };
}

export function quotaAvailable(snapshot: ProviderUsageSnapshot) {
  if (snapshot.status !== "available") return false;
  if (snapshot.availability === "available") return true;
  if (snapshot.availability !== "unknown") return false;
  return snapshot.windows.length > 0
    && snapshot.windows.every(({ remainingPercent }) => remainingPercent !== null && remainingPercent > 0);
}

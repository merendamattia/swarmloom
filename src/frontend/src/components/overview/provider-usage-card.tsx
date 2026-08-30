import type { Status } from "@/hooks/api";
import { dateTime } from "@/lib/format";

type ProviderUsage = Status["providerUsage"];
type QuotaWindow = ProviderUsage["windows"][number];

function durationLabel(minutes: number | null) {
  if (minutes === 300) return "5-hour";
  if (minutes === 10_080) return "Weekly";
  if (minutes === null) return "Unknown window";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

function windowLabel(window: QuotaWindow) {
  return durationLabel(window.windowDurationMins) === "Unknown window"
    ? window.limitName ?? window.limitId ?? "Unknown window"
    : durationLabel(window.windowDurationMins);
}

function QuotaWindowView({ window }: { window: QuotaWindow }) {
  const label = windowLabel(window);
  const remaining = window.remainingPercent;
  return (
    <div className="quota-window">
      <div className="quota-window-head">
        <strong>{label}</strong>
        {window.limitId ? <span className="mono">{window.limitId}</span> : null}
      </div>
      <p className="quota-remaining">{remaining === null ? "Remaining: Unknown" : `${remaining}% remaining`}</p>
      {remaining === null ? null : <progress className="quota-progress" max={100} value={remaining} aria-label={`${label} quota remaining`} />}
      <p className="quota-reset">
        Reset: {window.resetsAt ? <time dateTime={window.resetsAt}>{dateTime(window.resetsAt)}</time> : "Not recorded"}
      </p>
    </div>
  );
}

export function ProviderUsageCard({ provider, usage }: { provider: Status["provider"]; usage: ProviderUsage }) {
  const providerName = provider === "codex" ? "Codex" : "OpenCode";
  return (
    <section className="quota-section" aria-labelledby="quota-title">
      <div className="quota-heading">
        <div>
          <p className="eyebrow">{providerName} usage</p>
          <h3 id="quota-title">Account quota</h3>
        </div>
        {usage.observedAt ? <p className="quota-observed">Observed <time dateTime={usage.observedAt}>{dateTime(usage.observedAt)}</time></p> : null}
      </div>
      {usage.status === "unsupported" || provider !== "codex" ? (
        <p className="quota-message">Quota telemetry is unsupported for this provider.</p>
      ) : usage.status === "unavailable" ? (
        <p className="quota-message">{usage.message ?? "Quota telemetry is unavailable."}</p>
      ) : usage.windows.length === 0 ? (
        <p className="quota-message">No quota windows were reported by Codex.</p>
      ) : (
        <>
          {usage.availability === "exhausted" ? <p className="quota-message">Codex reports this allowance as exhausted.</p> : null}
          {usage.status === "stale" ? <p className="quota-message">Showing the last known snapshot; the latest refresh failed.</p> : null}
          <div className="quota-window-grid">
            {usage.windows.map((window, index) => <QuotaWindowView key={`${window.limitId ?? "unknown"}-${window.windowType}-${index}`} window={window} />)}
          </div>
        </>
      )}
    </section>
  );
}

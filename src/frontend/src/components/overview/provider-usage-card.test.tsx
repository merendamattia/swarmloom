import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderUsageCard } from "./provider-usage-card";

describe("ProviderUsageCard", () => {
  test("renders provider-reported standard windows and unknown fields explicitly", () => {
    const html = renderToStaticMarkup(<ProviderUsageCard
      provider="codex"
      usage={{
        status: "available",
        availability: "available",
        spendControlReached: null,
        rateLimitReachedType: null,
        observedAt: "2026-08-29T20:00:00.000Z",
        windows: [
          {
            limitId: "codex",
            limitName: null,
            windowType: "primary",
            usedPercent: 25,
            remainingPercent: 75,
            windowDurationMins: 300,
            resetsAt: "2026-08-30T01:00:00.000Z",
          },
          {
            limitId: "codex",
            limitName: null,
            windowType: "secondary",
            usedPercent: null,
            remainingPercent: null,
            windowDurationMins: 10_080,
            resetsAt: null,
          },
        ],
      }}
    />);

    expect(html).toContain("Account quota");
    expect(html).toContain("5-hour");
    expect(html).toContain("75% remaining");
    expect(html).toContain("Weekly");
    expect(html).toContain("Remaining: Unknown");
    expect(html).toContain("Reset: Not recorded");
    expect(html).toContain("aria-label=\"5-hour quota remaining\"");
  });

  test("does not show quota values for unsupported providers", () => {
    const html = renderToStaticMarkup(<ProviderUsageCard
      provider="opencode"
      usage={{
        status: "unsupported",
        availability: "unknown",
        spendControlReached: null,
        rateLimitReachedType: null,
        observedAt: null,
        windows: [],
        message: "ignored",
      }}
    />);

    expect(html).toContain("Quota telemetry is unsupported for this provider.");
    expect(html).not.toContain("ignored");
    expect(html).not.toContain("% remaining");
  });

  test("calls out provider-confirmed exhaustion separately from window percentages", () => {
    const html = renderToStaticMarkup(<ProviderUsageCard
      provider="codex"
      usage={{
        status: "available",
        availability: "exhausted",
        spendControlReached: true,
        rateLimitReachedType: "workspaceMemberUsageLimitReached",
        observedAt: null,
        windows: [{
          limitId: "codex",
          limitName: null,
          windowType: "primary",
          usedPercent: 40,
          remainingPercent: 60,
          windowDurationMins: 300,
          resetsAt: null,
        }],
      }}
    />);

    expect(html).toContain("Codex reports this allowance as exhausted.");
    expect(html).toContain("60% remaining");
  });

  test("shows provider-confirmed exhaustion when no quota windows are available", () => {
    const html = renderToStaticMarkup(<ProviderUsageCard
      provider="codex"
      usage={{
        status: "available",
        availability: "exhausted",
        spendControlReached: true,
        rateLimitReachedType: null,
        observedAt: null,
        windows: [],
      }}
    />);

    expect(html).toContain("Codex reports this allowance as exhausted.");
    expect(html).not.toContain("No quota windows were reported by Codex.");
  });

  test("reports a stale empty snapshot instead of treating it as a healthy empty result", () => {
    const html = renderToStaticMarkup(<ProviderUsageCard
      provider="codex"
      usage={{
        status: "stale",
        availability: "unknown",
        spendControlReached: null,
        rateLimitReachedType: null,
        observedAt: null,
        windows: [],
        message: "The last Codex quota snapshot may be out of date",
      }}
    />);

    expect(html).toContain("The last Codex quota snapshot may be out of date");
    expect(html).not.toContain("No quota windows were reported by Codex.");
  });

  test("preserves the reason when Codex quota mapping is unknown", () => {
    const html = renderToStaticMarkup(<ProviderUsageCard
      provider="codex"
      usage={{
        status: "available",
        availability: "unknown",
        spendControlReached: null,
        rateLimitReachedType: null,
        observedAt: null,
        windows: [],
        message: "Codex reported quota buckets without a reliable applicable mapping",
      }}
    />);

    expect(html).toContain("Codex reported quota buckets without a reliable applicable mapping");
    expect(html).not.toContain("No quota windows were reported by Codex.");
  });
});

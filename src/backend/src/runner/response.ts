export type JobOutcome = "implemented" | "blocked" | "decomposed" | "requires_decomposition";
export type ReviewOutcome = "pass" | "changes_requested";

const JOB_OUTCOMES = new Set<JobOutcome>(["implemented", "blocked", "decomposed", "requires_decomposition"]);

export type FrontendVisualRequest = {
  frontendChanged: boolean;
  route: string | null;
  origin: string | null;
  setup: string | null;
};

function markerLine(text: string, field: "Outcome" | "Review" | "PR" | "Frontend change" | "Visual route" | "Visual origin" | "Visual setup"): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(`${field.toLowerCase()}:`)) {
      return trimmed.slice(field.length + 1).trim() || null;
    }
  }
  return null;
}

function evidence(text: string) {
  return text.length > 2_000 ? text.slice(-2_000) : text;
}

export function parseJobOutcome(text: string): JobOutcome {
  const outcome = markerLine(text, "Outcome");
  if (!outcome || !JOB_OUTCOMES.has(outcome as JobOutcome)) {
    throw new Error('Agent response must start with "Outcome: implemented" | "blocked" | "decomposed" | "requires_decomposition"', {
      cause: evidence(text),
    });
  }
  return outcome as JobOutcome;
}

export function parseReviewOutcome(text: string): ReviewOutcome {
  const review = markerLine(text, "Review");
  if (review !== "pass" && review !== "changes_requested") {
    throw new Error('Agent review must start with "Review: pass" | "changes_requested"', {
      cause: evidence(text),
    });
  }
  return review;
}

export function parsePullRequestUrl(text: string): string | null {
  const url = markerLine(text, "PR");
  return url && /\/pull\/\d+/.test(url) ? url : null;
}

export function parseFrontendVisualRequest(text: string): FrontendVisualRequest {
  const declaration = markerLine(text, "Frontend change")?.toLowerCase();
  if (declaration === "unchanged") return { frontendChanged: false, route: null, origin: null, setup: null };
  if (declaration !== "changed") {
    throw new Error('Implemented agent response must include "Frontend change: changed|unchanged"', {
      cause: evidence(text),
    });
  }
  const rawRoute = markerLine(text, "Visual route");
  const route = rawRoute && rawRoute.startsWith("/") && !rawRoute.startsWith("//") ? rawRoute : null;
  if (!route) {
    throw new Error('Implemented agent response must include "Visual route: /the/relevant/path"', {
      cause: evidence(text),
    });
  }
  const rawOrigin = markerLine(text, "Visual origin");
  const origin = parseVisualOrigin(rawOrigin);
  if (!origin) {
    throw new Error('Implemented agent response must include "Visual origin: http://localhost:<port>"', {
      cause: evidence(text),
    });
  }
  const setup = markerLine(text, "Visual setup");
  if (!setup) {
    throw new Error('Implemented agent response must include "Visual setup: <command or none>"', {
      cause: evidence(text),
    });
  }
  return {
    frontendChanged: true,
    route,
    origin,
    setup,
  };
}

function parseVisualOrigin(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

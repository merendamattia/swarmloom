export type JobOutcome = "implemented" | "blocked" | "decomposed" | "requires_decomposition";
export type ReviewOutcome = "pass" | "changes_requested";

const JOB_OUTCOMES = new Set<JobOutcome>(["implemented", "blocked", "decomposed", "requires_decomposition"]);

function markerLine(text: string, field: "Outcome" | "Review" | "PR"): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(`${field.toLowerCase()}:`)) {
      return trimmed.slice(field.length + 1).trim() || null;
    }
  }
  return null;
}

export function parseJobOutcome(text: string): JobOutcome {
  const outcome = markerLine(text, "Outcome");
  if (!outcome || !JOB_OUTCOMES.has(outcome as JobOutcome)) {
    throw new Error('Agent response must start with "Outcome: implemented" | "blocked" | "decomposed" | "requires_decomposition"');
  }
  return outcome as JobOutcome;
}

export function parseReviewOutcome(text: string): ReviewOutcome {
  const review = markerLine(text, "Review");
  if (review !== "pass" && review !== "changes_requested") {
    throw new Error('Agent review must start with "Review: pass" | "changes_requested"');
  }
  return review;
}

export function parsePullRequestUrl(text: string): string | null {
  const url = markerLine(text, "PR");
  return url && /\/pull\/\d+/.test(url) ? url : null;
}

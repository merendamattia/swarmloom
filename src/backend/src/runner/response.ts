export type JobOutcome = "implemented" | "blocked" | "decomposed" | "requires_decomposition";
export type ReviewOutcome = "pass" | "changes_requested";

const JOB_OUTCOMES = new Set<JobOutcome>(["implemented", "blocked", "decomposed", "requires_decomposition"]);

function markerIndex(lines: string[], field: "Outcome" | "Review" | "PR"): number {
  return lines.findIndex((line) => line.trim().toLowerCase().startsWith(`${field.toLowerCase()}:`));
}

function markerLine(text: string, field: "Outcome" | "Review" | "PR"): string | null {
  const lines = text.split(/\r?\n/);
  const index = markerIndex(lines, field);
  if (index < 0) return null;
  return lines[index].trim().slice(field.length + 1).trim() || null;
}

function nextContentIndex(lines: string[], start: number): number {
  return lines.findIndex((line, index) => index >= start && line.trim().length > 0);
}

function validateSummary(text: string, field: "Outcome" | "Review") {
  const lines = text.split(/\r?\n/);
  const resultIndex = markerIndex(lines, field);
  if (nextContentIndex(lines, 0) !== resultIndex) {
    throw new Error(`Agent response must start with a ${field}: marker`);
  }

  const firstFollowingIndex = nextContentIndex(lines, resultIndex + 1);
  if (firstFollowingIndex < 0) {
    throw new Error(`Agent response must include "TL;DR: <brief summary>" after the ${field}: marker`);
  }

  const firstFollowing = lines[firstFollowingIndex].trim();
  const hasPullRequestMarker = firstFollowing.toLowerCase().startsWith("pr:");
  const summaryIndex = hasPullRequestMarker
    ? nextContentIndex(lines, firstFollowingIndex + 1)
    : firstFollowingIndex;
  const pullRequestIndex = markerIndex(lines, "PR");
  if (pullRequestIndex >= 0 && pullRequestIndex !== firstFollowingIndex) {
    throw new Error('Agent response must place the "PR:" line before "TL;DR:"');
  }

  const summary = summaryIndex >= 0 ? lines[summaryIndex].trim() : "";
  if (!summary.toLowerCase().startsWith("tl;dr:") || !summary.slice("TL;DR:".length).trim()) {
    throw new Error(`Agent response must include "TL;DR: <brief summary>" immediately after the ${field}: marker`);
  }
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
  validateSummary(text, "Outcome");
  return outcome as JobOutcome;
}

export function parseReviewOutcome(text: string): ReviewOutcome {
  const review = markerLine(text, "Review");
  if (review !== "pass" && review !== "changes_requested") {
    throw new Error('Agent review must start with "Review: pass" | "changes_requested"', {
      cause: evidence(text),
    });
  }
  validateSummary(text, "Review");
  return review;
}

export function parsePullRequestUrl(text: string): string | null {
  const url = markerLine(text, "PR");
  return url && /\/pull\/\d+/.test(url) ? url : null;
}

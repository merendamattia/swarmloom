import type { PullRequestCheck } from "../github/client.ts";

export type PullRequestCheckState = "pending" | "passed" | "failed";

export function pullRequestCheckState(checks: PullRequestCheck[]): PullRequestCheckState {
  if (checks.some((check) => check.status !== "completed")) return "pending";
  if (checks.some((check) => !["success", "neutral", "skipped"].includes(check.conclusion ?? ""))) {
    return "failed";
  }
  return "passed";
}

export class PullRequestChecksError extends Error {
  constructor(
    readonly pullRequestNumber: number,
    readonly pullRequestUrl: string,
    readonly checks: PullRequestCheck[],
    readonly diagnosis: string,
  ) {
    const failed = checks.filter((check) => !["success", "neutral", "skipped"].includes(check.conclusion ?? ""));
    super(`Pull Request #${pullRequestNumber} has failing CI/CD checks: ${failed.map((check) => check.name).join(", ")}`);
    this.name = "PullRequestChecksError";
  }
}

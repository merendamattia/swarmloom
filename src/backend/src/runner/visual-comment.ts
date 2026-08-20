import type { VisualVerificationResult } from "./visual-verification.ts";

export function visualEvidenceComment(result: Extract<VisualVerificationResult, { status: "COMPLETED" }>) {
  return [
    "## Visual evidence",
    "",
    `Route: \`${result.route}\``,
    "",
    `![Screenshot of ${result.route}](${result.artifactUrl})`,
  ].join("\n");
}

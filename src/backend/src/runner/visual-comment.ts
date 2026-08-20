import type { VisualVerificationResult } from "./visual-verification.ts";

export function visualEvidenceMarker(key: string) {
  return `<!-- swarmloom:visual-evidence:${key} -->`;
}

export function visualEvidenceComment(result: Extract<VisualVerificationResult, { status: "COMPLETED" }>, key: string) {
  return [
    visualEvidenceMarker(key),
    "",
    "## Visual evidence",
    "",
    `Route: \`${result.route}\``,
    "",
    `![Screenshot of ${result.route}](${result.artifactUrl})`,
  ].join("\n");
}

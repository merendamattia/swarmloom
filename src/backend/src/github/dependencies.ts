import type { ParentIssue } from "./client.ts";

const permanentlyBlockedReasons = new Set(["not_planned", "duplicate"]);

export function dependencyStatus(parent: ParentIssue): { satisfied: true; reason: null } | { satisfied: false; reason: string } {
  if (parent.state !== "closed") {
    return { satisfied: false, reason: `Waiting for prerequisite issue #${parent.number} to be implemented` };
  }
  if (parent.stateReason != null && permanentlyBlockedReasons.has(parent.stateReason)) {
    return { satisfied: false, reason: `Prerequisite issue #${parent.number} was closed as ${parent.stateReason.replace("_", " ")}` };
  }
  return { satisfied: true, reason: null };
}

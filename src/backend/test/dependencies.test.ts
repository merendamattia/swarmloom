import { describe, expect, test } from "bun:test";
import type { ParentIssue } from "../src/github/client.ts";
import { isParentResolved } from "../src/scans/dependencies.ts";

function parent(state: ParentIssue["state"], stateReason: string | null): ParentIssue {
  return { number: 1, title: "Prerequisite", url: "https://github.com/acme/app/issues/1", state, stateReason };
}

describe("parent resolution", () => {
  test("releases a child only when the parent is closed as completed", () => {
    expect(isParentResolved(parent("closed", "completed"))).toBe(true);
    expect(isParentResolved(parent("open", null))).toBe(false);
    expect(isParentResolved(parent("open", "completed"))).toBe(false);
    expect(isParentResolved(parent("closed", null))).toBe(false);
    expect(isParentResolved(parent("closed", "not_planned"))).toBe(false);
    expect(isParentResolved(parent("closed", "duplicate"))).toBe(false);
    expect(isParentResolved(parent("closed", "reopened"))).toBe(false);
  });
});

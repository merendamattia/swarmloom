import { expect, test } from "bun:test";
import { safeWorktreePath } from "../src/runner/paths.ts";

test("isolates worktree paths by claim attempt", () => {
  expect(safeWorktreePath("/data", "job-1", 1)).not.toBe(safeWorktreePath("/data", "job-1", 2));
});

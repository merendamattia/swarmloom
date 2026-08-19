import { describe, expect, test } from "bun:test";
import { parseChangelogVersion } from "../src/core/version.ts";

describe("parseChangelogVersion", () => {
  test("parses the first level-one semantic-release heading", () => {
    expect(parseChangelogVersion("# [1.3.0](https://example.com/release) (2026-08-18)\n")).toBe("1.3.0");
  });

  test("parses the first level-two semantic-release heading", () => {
    expect(parseChangelogVersion("## [1.1.1](https://example.com/release) (2026-08-18)\n")).toBe("1.1.1");
  });

  test("rejects a changelog without a semantic-release heading", () => {
    expect(() => parseChangelogVersion("# Changelog\n\nNo releases yet.\n")).toThrow("No semantic version found in CHANGELOG.md");
  });
});

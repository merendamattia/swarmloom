import { describe, expect, test } from "bun:test";
import { parseReleaseVersion, readApplicationVersion } from "../src/core/version.ts";

describe("parseReleaseVersion", () => {
  test("reads the latest release from a semantic-release changelog", () => {
    expect(parseReleaseVersion(
      "# [1.3.0](https://github.com/merendamattia/swarmloom/compare/v1.2.0...v1.3.0) (2026-08-18)\n\n### Features\n\n* **frontend:** ship branding\n\n# [1.2.0](https://github.com/merendamattia/swarmloom/compare/v1.1.1...v1.2.0) (2026-08-18)",
    )).toBe("1.3.0");
  });

  test("handles the patch-level double-hash heading", () => {
    expect(parseReleaseVersion("## [1.1.1](https://github.com/merendamattia/swarmloom/compare/v1.1.0...v1.1.1) (2026-08-18)")).toBe("1.1.1");
  });

  test("handles the bare initial release heading without brackets", () => {
    expect(parseReleaseVersion("# 1.0.0 (2026-08-18)")).toBe("1.0.0");
  });

  test("fails when no supported release heading can produce a version", () => {
    expect(() => parseReleaseVersion("# Changelog\n\nAll notable changes to this project are documented here.")).toThrow();
  });

  test("reads the changelog used to build the application", async () => {
    expect(await readApplicationVersion()).toBe("1.3.0");
  });
});
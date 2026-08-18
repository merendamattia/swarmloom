import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactDirectory,
  artifactFileName,
  artifactPublicUrl,
  VISUAL_VIEWPORT,
  visualEvidenceComment,
} from "../src/runner/visual.ts";

describe("visual evidence helpers", () => {
  test("captures a fixed deterministic viewport", () => {
    expect(VISUAL_VIEWPORT).toEqual({ width: 1280, height: 800 });
  });

  test("builds an unguessable PNG file name", () => {
    const first = artifactFileName();
    const second = artifactFileName();
    expect(first).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(first).not.toBe(second);
  });

  test("builds a public artifact URL under /api/artifacts", () => {
    expect(artifactPublicUrl("https://worker.example.com", "job-1", "abc.png"))
      .toBe("https://worker.example.com/api/artifacts/job-1/abc.png");
    expect(artifactPublicUrl("http://localhost:18421", "job-2", "def.png"))
      .toBe("http://localhost:18421/api/artifacts/job-2/def.png");
  });

  test("keeps artifact files inside the data directory for a given job", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "swarmloom-artifacts-"));
    try {
      const path = artifactDirectory(dataDir, "job-1");
      expect(path.startsWith(join(dataDir, "artifacts"))).toBe(true);
      expect(() => artifactDirectory(dataDir, "../escape")).toThrow("escapes data directory");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("renders one Markdown visual-evidence comment with image and direct link", () => {
    const comment = visualEvidenceComment("/settings", "https://worker.example.com/api/artifacts/job-1/abc.png");
    expect(comment).toContain("Screenshot of the implemented view at `/settings`");
    expect(comment).toContain("![Implemented view at /settings](https://worker.example.com/api/artifacts/job-1/abc.png)");
    expect(comment).toContain("[Open screenshot directly](https://worker.example.com/api/artifacts/job-1/abc.png)");
    expect((comment.match(/worker\.example\.com/g) ?? []).length).toBe(2);
  });
});

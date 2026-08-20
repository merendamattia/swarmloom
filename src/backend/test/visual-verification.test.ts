import { describe, expect, test } from "bun:test";
import { createVisualArtifactUrl, verifyArtifactToken } from "../src/artifacts.ts";
import { parseFrontendVisualRequest } from "../src/runner/response.ts";

describe("visual verification contract", () => {
  test("requires an explicit route and setup marker for frontend changes", () => {
    expect(parseFrontendVisualRequest([
      "Outcome: implemented",
      "Frontend change: changed",
      "Visual route: /settings?tab=telegram",
      "Visual setup: bun run dev:frontend",
    ].join("\n"))).toEqual({
      frontendChanged: true,
      route: "/settings?tab=telegram",
      setup: "bun run dev:frontend",
    });
    expect(parseFrontendVisualRequest("Outcome: implemented\nFrontend change: unchanged"))
      .toEqual({ frontendChanged: false, route: null, setup: null });
  });

  test("signs artifact URLs without exposing the signing secret", () => {
    const now = 1_750_000_000_000;
    const url = createVisualArtifactUrl("https://worker.example.com", "settings-secret", "job-1", now);
    const token = new URL(url).searchParams.get("token");
    expect(url).toStartWith("https://worker.example.com/api/artifacts/job-1?token=");
    expect(token).not.toContain("settings-secret");
    expect(verifyArtifactToken("settings-secret", "job-1", token!, now)).toBe(true);
    expect(verifyArtifactToken("wrong-secret", "job-1", token!, now)).toBe(false);
    expect(verifyArtifactToken("settings-secret", "job-1", token!, now + 31 * 24 * 60 * 60 * 1_000)).toBe(false);
  });
});

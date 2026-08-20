import { describe, expect, test } from "bun:test";
import { createVisualArtifactUrl, verifyArtifactToken } from "../src/artifacts.ts";
import { parseFrontendVisualRequest } from "../src/runner/response.ts";
import { visualRouteUrl, waitForPage } from "../src/runner/visual-verification.ts";

describe("visual verification contract", () => {
  test("requires an explicit route and setup marker for frontend changes", () => {
    expect(parseFrontendVisualRequest([
      "Outcome: implemented",
      "Frontend change: changed",
      "Visual route: /settings?tab=telegram",
      "Visual origin: http://localhost:3000",
      "Visual setup: bun run dev:frontend",
    ].join("\n"))).toEqual({
      frontendChanged: true,
      route: "/settings?tab=telegram",
      origin: "http://localhost:3000",
      setup: "bun run dev:frontend",
    });
    expect(parseFrontendVisualRequest("Outcome: implemented\nFrontend change: unchanged"))
      .toEqual({ frontendChanged: false, route: null, origin: null, setup: null });
  });

  test("rejects a changed frontend response without visual setup", () => {
    expect(() => parseFrontendVisualRequest([
      "Outcome: implemented",
      "Frontend change: changed",
      "Visual route: /settings",
      "Visual origin: http://localhost:3000",
    ].join("\n"))).toThrow('Implemented agent response must include "Visual setup: <command or none>"');
  });

  test("resolves the browser route against the declared target origin", () => {
    expect(visualRouteUrl("http://localhost:3000", "/settings?tab=telegram").href)
      .toBe("http://localhost:3000/settings?tab=telegram");
  });


  test("navigates the browser to the declared target app", async () => {
    const visited: string[] = [];
    const page = {
      goto: async (url: string) => { visited.push(url); },
      waitForLoadState: async () => {},
    } as unknown as Parameters<typeof waitForPage>[0];
    await waitForPage(page, visualRouteUrl("http://localhost:3000", "/settings").href, new AbortController().signal);
    expect(visited).toEqual(["http://localhost:3000/settings"]);
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

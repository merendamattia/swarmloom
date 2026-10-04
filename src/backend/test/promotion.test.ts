import { describe, expect, test } from "bun:test";
import { promotionBody, promoteDevelop } from "../src/scans/promotion.ts";

describe("develop promotion", () => {
  test("collects issues from managed and external merged PRs, preserving existing body text", async () => {
    let body = "Release notes\n\n## Issues included in this promotion\n\nCloses #7\n\n## Manual notes\n\nKeep this text.";
    let creates = 0;
    const github = {
      compareBranches: async () => ({ aheadBy: 2, mergeBaseDate: "2026-10-01T00:00:00Z" }),
      listMergedPullRequests: async () => [
        { number: 11, body: "Closes #8\nFixes #9", mergedAt: "2026-10-02T00:00:00Z" },
        { number: 12, body: "", mergedAt: "2026-10-03T00:00:00Z" },
      ],
      findPromotionPullRequest: async () => ({ number: 20, body }),
      createPromotionPullRequest: async () => { creates++; },
      updatePullRequestBody: async (_repo: string, _number: number, next: string) => { body = next; },
    };
    const dependencies = {
      github,
      managedIssue: async (number: number) => number === 12 ? 10 : null,
      withLock: async (action: () => Promise<void>) => action(),
      warn: async () => {},
    };

    await promoteDevelop("acme/app", dependencies);
    await promoteDevelop("acme/app", dependencies);

    expect(creates).toBe(0);
    expect(body).toContain("## Manual notes\n\nKeep this text.");
    for (const issue of [7, 8, 9, 10]) expect(body.match(new RegExp(`Closes #${issue}\\b`, "g"))).toHaveLength(1);
  });

  test("creates one PR when develop is ahead and skips creation when aligned", async () => {
    let aheadBy = 1;
    let created = 0;
    let open = false;
    const github = {
      compareBranches: async () => ({ aheadBy, mergeBaseDate: "2026-10-01T00:00:00Z" }),
      listMergedPullRequests: async () => [{ number: 5, body: "Resolves #5", mergedAt: "2026-10-02T00:00:00Z" }],
      findPromotionPullRequest: async () => open ? { number: 25, body: "Closes #5" } : null,
      createPromotionPullRequest: async () => { created++; open = true; },
      updatePullRequestBody: async () => {},
    };
    const dependencies = {
      github,
      managedIssue: async () => null,
      withLock: async (action: () => Promise<void>) => action(),
      warn: async () => {},
    };
    await promoteDevelop("acme/app", dependencies);
    await promoteDevelop("acme/app", dependencies);
    aheadBy = 0;
    await promoteDevelop("acme/app", dependencies);
    expect(created).toBe(1);
  });

  test("deduplicates existing managed references", () => {
    expect(promotionBody("## Issues included in this promotion\n\nCloses #2\nCloses #2", [2, 3]))
      .toBe("## Issues included in this promotion\n\nCloses #2\nCloses #3");
    expect(promotionBody("Release notes\n\nCloses #2", [2, 3]))
      .toBe("Release notes\n\nCloses #2\n\n## Issues included in this promotion\n\nCloses #3");
  });

  test("recovers a concurrent creation by merging issues into the winner", async () => {
    let body = "Closes #4";
    const github = {
      compareBranches: async () => ({ aheadBy: 1, mergeBaseDate: "2026-10-01T00:00:00Z" }),
      listMergedPullRequests: async () => [{ number: 5, body: "Closes #5", mergedAt: "2026-10-02T00:00:00Z" }],
      findPromotionPullRequest: async () => body === "Closes #4" ? null : { number: 20, body },
      createPromotionPullRequest: async () => { body = "Release notes\n\nCloses #4"; throw new Error("GitHub API request failed (422)"); },
      updatePullRequestBody: async (_repo: string, _number: number, next: string) => { body = next; },
    };
    await promoteDevelop("acme/app", {
      github,
      managedIssue: async () => null,
      withLock: async (action) => action(),
      warn: async () => {},
    });
    expect(body).toContain("Closes #4");
    expect(body).toContain("Closes #5");
  });
});

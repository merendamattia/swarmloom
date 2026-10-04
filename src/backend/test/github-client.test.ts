import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config-schema.ts";
import { createGitHubClient } from "../src/github/client.ts";
import { agentLabelDefinitions } from "../src/github/labels.ts";

describe("GitHub client", () => {
  test("compares branches and finds only an open in-repository develop promotion", async () => {
    const requests: Request[] = [];
    const client = createGitHubClient({ token: "secret-token", fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes("/compare/")) return Response.json({ ahead_by: 1, base_commit: { commit: { tree: { sha: "main-tree" } } }, merge_base_commit: { commit: { committer: { date: "2026-10-01T00:00:00Z" } } } });
      if (request.url.includes("/branches/develop")) return Response.json({ commit: { commit: { tree: { sha: "develop-tree" } } } });
      if (request.url.includes("state=closed")) return Response.json([{
        ...pullRequest(8), merged_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
      }]);
      return Response.json([
        { ...pullRequest(9), head: { ref: "develop", repo: { full_name: "other/app" } } },
        { ...pullRequest(10), head: { ref: "develop", repo: { full_name: "acme/app" } } },
      ]);
    } });

    expect(await client.compareBranches("acme/app", "main", "develop"))
      .toEqual({ aheadBy: 1, hasChanges: true, mergeBaseDate: "2026-10-01T00:00:00Z" });
    expect(await client.listMergedPullRequests("acme/app", "develop", "2026-10-01T00:00:00Z"))
      .toEqual([{ number: 8, body: "Closes #7", mergedAt: "2026-10-02T00:00:00Z" }]);
    expect(await client.findPromotionPullRequest("acme/app")).toEqual({ number: 10, body: "Closes #7" });
    expect(requests[2].url).toContain("base=develop");
    expect(requests[3].url).toContain("base=main");
  });

  test("recognizes identical branch trees after a squash promotion and finds the latest merged promotion", async () => {
    const requests: Request[] = [];
    const client = createGitHubClient({ token: "secret-token", fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes("/compare/")) return Response.json({ ahead_by: 2, base_commit: { commit: { tree: { sha: "shared-tree" } } }, merge_base_commit: { commit: { committer: { date: "2026-10-01T00:00:00Z" } } } });
      if (request.url.includes("/branches/develop")) return Response.json({ commit: { commit: { tree: { sha: "shared-tree" } } } });
      return Response.json([
        { ...pullRequest(20), head: { ref: "develop", repo: { full_name: "other/app" } }, merged_at: "2026-10-04T00:00:00Z" },
        { ...pullRequest(21), head: { ref: "develop", repo: { full_name: "acme/app" } }, merged_at: "2026-10-03T00:00:00Z" },
      ]);
    } });

    expect(await client.compareBranches("acme/app", "main", "develop"))
      .toEqual({ aheadBy: 2, hasChanges: false, mergeBaseDate: "2026-10-01T00:00:00Z" });
    expect(await client.lastMergedPromotionDate("acme/app")).toBe("2026-10-03T00:00:00Z");
    expect(requests[2].url).toContain("head=acme%3Adevelop");
  });

  test("lists open pull requests by workflow label", async () => {
    const requests: Request[] = [];
    const client = createGitHubClient({
      token: "secret-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json([{ ...issue(9), pull_request: { url: "https://api.github.test/pulls/9" } }]);
      },
    });

    expect(await client.listPullRequests("acme/app", "agent:review-requested")).toEqual([{
      number: 9,
      title: "Fix queue",
      body: "Acceptance criteria",
      url: "https://github.com/acme/app/issues/9",
      labels: ["bug", "agent:ready"],
    }]);
    expect(requests[0]?.url).toContain("/repos/acme/app/issues?state=open&labels=agent%3Areview-requested");
  });

  test("lists ready issues without treating pull requests as jobs", async () => {
    const requests: Request[] = [];
    const client = createGitHubClient({
      token: "secret-token",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json([
          issue(7),
          { ...issue(8), pull_request: { url: "https://api.github.test/pulls/8" } },
        ]);
      },
    });

    const issues = await client.listReadyIssues("acme/app", "agent:ready");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      number: 7,
      title: "Fix queue",
      body: "Acceptance criteria",
      url: "https://github.com/acme/app/issues/7",
      labels: ["bug", "agent:ready"],
    });
    expect(requests[0].url).toContain("/repos/acme/app/issues?state=open&labels=agent%3Aready");
    expect(requests[0].headers.get("authorization")).toBe("Bearer secret-token");
  });

  test("finds support issues by job marker without matching pull requests", async () => {
    const requests: Request[] = [];
    const client = createGitHubClient({
      token: "secret-token",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json([
          { ...issue(7), body: "Job ID: `job-123`" },
          { ...issue(8), body: "Job ID: `job-123`", pull_request: { url: "https://api.github.test/pulls/8" } },
        ]);
      },
    });

    expect(await client.findIssueByMarker("acme/app", "Job ID: `job-123`"))
      .toEqual({ number: 7, url: "https://github.com/acme/app/issues/7" });
    expect(requests[0]?.url).toContain("/repos/acme/app/issues?state=all");
  });

  test("replaces issue labels and adds comments through authenticated JSON requests", async () => {
    const requests: Request[] = [];
    const client = createGitHubClient({
      token: "secret-token",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({}, { status: 200 });
      },
    });

    await client.setIssueLabels("acme/app", 7, ["bug", "agent:working"]);
    await client.addIssueComment("acme/app", 7, "The worker started this job.");

    expect(requests.map((request) => request.method)).toEqual(["PUT", "POST"]);
    expect(await requests[0].json()).toEqual({ labels: ["bug", "agent:working"] });
    expect(await requests[1].json()).toEqual({ body: "The worker started this job." });
  });

  test("returns repository clone metadata without including credentials in the URL", async () => {
    const client = createGitHubClient({
      token: "secret-token",
      fetch: async () => Response.json({ clone_url: "https://github.com/acme/app.git" }),
    });

    expect(await client.getRepository("acme/app")).toEqual({
      cloneUrl: "https://github.com/acme/app.git",
    });
  });

  test("loads current issue labels and verifies PR metadata and diff", async () => {
    const requests: Request[] = [];
    const client = createGitHubClient({
      token: "secret-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.headers.get("accept") === "application/vnd.github.v3.diff") {
          return new Response("diff --git a/a.ts b/a.ts");
        }
        if (request.url.endsWith("/pulls/9")) return Response.json(pullRequest(9));
        return Response.json(issue(7));
      },
    });

    expect((await client.getIssue("acme/app", 7)).labels).toEqual(["bug", "agent:ready"]);
    expect(await client.getPullRequest("acme/app", 9)).toEqual({
      number: 9,
      title: "Fix queue",
      url: "https://github.com/acme/app/pull/9",
      base: "develop",
      head: "agent/issue-7",
      headSha: "a".repeat(40),
      state: "open",
      merged: false,
      body: "Closes #7",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
    });
    expect(await client.getPullRequestDiff("acme/app", 9)).toStartWith("diff --git");
  });

  test("loads issue and linked pull request context for a specific PR number", async () => {
    const requests: Request[] = [];
    const client = createGitHubClient({
      token: "secret-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.includes("/issues/7/comments")) return Response.json([{
          body: "Please also cover the empty case.",
          html_url: "https://github.com/acme/app/issues/7#issuecomment-1",
          user: { login: "reviewer" },
          created_at: "2026-08-18T10:00:00Z",
        }]);
        if (request.url.includes("/pulls/9/reviews")) return Response.json([{
          body: "Add a regression test.",
          state: "CHANGES_REQUESTED",
          html_url: "https://github.com/acme/app/pull/9#pullrequestreview-1",
          user: { login: "reviewer" },
          submitted_at: "2026-08-18T10:01:00Z",
        }]);
        if (request.url.includes("/pulls/9/comments")) return Response.json([{
          body: "This branch misses the empty case.",
          path: "src/app.ts",
          line: 12,
          html_url: "https://github.com/acme/app/pull/9#discussion_r1",
          user: { login: "reviewer" },
          created_at: "2026-08-18T10:02:00Z",
        }]);
        if (request.headers.get("accept") === "application/vnd.github.v3.diff") return new Response("diff --git a/src/app.ts b/src/app.ts");
        if (request.url.endsWith("/pulls/9")) return Response.json(pullRequest(9));
        if (request.url.endsWith("/issues/7")) return Response.json(issue(7));
        if (request.url.endsWith("/issues")) return Response.json({
          number: 13,
          html_url: "https://github.com/acme/app/issues/13",
        }, { status: 201 });
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const context = await client.getIssueContext("acme/app", 7, "https://github.com/acme/app/issues/7", 9);
    expect(context.issueComments).toHaveLength(1);
    expect(context.pullRequests).toHaveLength(1);
    expect(context.pullRequests[0]).toMatchObject({
      number: 9,
      headSha: "a".repeat(40),
      diff: "diff --git a/src/app.ts b/src/app.ts",
      reviews: [{ state: "CHANGES_REQUESTED" }],
      comments: [{ path: "src/app.ts", line: 12 }],
    });
    expect(requests.some((request) => request.url.includes("/pulls?"))).toBe(false);
    expect(await client.createIssue("acme/app", "[Swarmloom] Job failure", "Details", ["agent:ready"])).toEqual({
      number: 13,
      url: "https://github.com/acme/app/issues/13",
    });
    expect(requests.some((request) => request.url.includes("/pulls/9/reviews"))).toBe(true);
    expect(requests.some((request) => request.url.includes("/pulls/9/comments"))).toBe(true);
  });

  test("reads and writes pull request labels through the shared issue-label endpoint", async () => {
    const requests: Request[] = [];
    const client = createGitHubClient({
      token: "secret-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") return Response.json([{ name: "agent:review-requested" }, { name: "feature" }]);
        return Response.json({}, { status: 200 });
      },
    });

    expect(await client.getPullRequestLabels("acme/app", 9)).toEqual(["agent:review-requested", "feature"]);
    await client.setPullRequestLabels("acme/app", 9, ["feature", "agent:fix-requested"]);
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
    expect(await requests[1].json()).toEqual({ labels: ["feature", "agent:fix-requested"] });
  });

  test("creates missing agent labels and repairs existing descriptions", async () => {
    const requests: Request[] = [];
    const config = parseConfig({
      DATABASE_URL: "postgresql://worker:worker@localhost:5432/worker",
      REDIS_URL: "redis://localhost:18422",
      SETTINGS_ENCRYPTION_KEY: "test-settings-encryption-key-0123456789",
      GITHUB_TOKEN: "secret-token",
      GITHUB_REPOSITORIES: "acme/app",
      AGENT_PROVIDER: "codex",
    });
    const client = createGitHubClient({
      token: "secret-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") return Response.json([{ name: config.ISSUE_READY_LABEL, description: null }]);
        return Response.json({}, { status: request.method === "POST" ? 201 : 200 });
      },
    });

    await client.ensureLabels("acme/app", agentLabelDefinitions(config));

    const creates = requests.filter((request) => request.method === "POST");
    const updates = requests.filter((request) => request.method === "PATCH");
    expect(creates).toHaveLength(8);
    expect(updates).toHaveLength(1);
    expect(await Promise.all(creates.map((request) => request.clone().json())))
      .toContainEqual(expect.objectContaining({ name: config.ISSUE_HUMAN_REVIEW_LABEL }));
    expect(await Promise.all(creates.map((request) => request.clone().json())))
      .toContainEqual(expect.objectContaining({ name: config.PR_REVIEW_REQUESTED_LABEL }));
    expect(await updates[0]?.json()).toMatchObject({ description: expect.any(String) });
  });

  function issue(number: number) {
    return {
      number,
      title: "Fix queue",
      body: "Acceptance criteria",
      html_url: `https://github.com/acme/app/issues/${number}`,
      labels: [{ name: "bug" }, { name: "agent:ready" }],
    };
  }

  function pullRequest(number: number) {
    return {
      number,
      html_url: `https://github.com/acme/app/pull/${number}`,
      title: "Fix queue",
      base: { ref: "develop" },
      head: { ref: "agent/issue-7", sha: "a".repeat(40) },
      body: "Closes #7",
      additions: 12,
      deletions: 3,
      changed_files: 2,
      state: "open",
      merged: false,
    };
  }
});

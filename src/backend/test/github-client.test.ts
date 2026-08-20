import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config-schema.ts";
import { createGitHubClient } from "../src/github/client.ts";
import { agentLabelDefinitions } from "../src/github/labels.ts";

describe("GitHub client", () => {
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
    expect(creates).toHaveLength(9);
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

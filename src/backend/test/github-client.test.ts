import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/core/config-schema.ts";
import { createGitHubClient } from "../src/github/client.ts";
import { agentLabelDefinitions } from "../src/github/labels.ts";

describe("GitHub client", () => {
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

  test("lists issue and pull request discussion and updates the issue body", async () => {
    const requests: Request[] = [];
    const client = createGitHubClient({
      token: "secret-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "PATCH") return Response.json({}, { status: 200 });
        if (request.url.includes("/pulls/9/reviews")) return Response.json([
          { id: 41, state: "CHANGES_REQUESTED", body: "Fix the guard" },
        ]);
        if (request.url.includes("/pulls/9/comments")) return Response.json([
          { id: 42, body: "Line comment" },
        ]);
        return Response.json([{ id: 40, body: "What about the retry?" }]);
      },
    });

    expect(await client.listIssueComments("acme/app", 7)).toEqual([{ id: 40, body: "What about the retry?" }]);
    expect(await client.listPullRequestComments("acme/app", 9)).toEqual([{ id: 42, body: "Line comment" }]);
    expect(await client.listPullRequestReviews("acme/app", 9))
      .toEqual([{ id: 41, state: "CHANGES_REQUESTED", body: "Fix the guard" }]);
    await client.updateIssue("acme/app", 7, "Follow-up body");

    const patch = requests.find((request) => request.method === "PATCH")!;
    expect(patch.url).toContain("/repos/acme/app/issues/7");
    expect(await patch.json()).toEqual({ body: "Follow-up body" });
    expect(requests.filter((request) => request.url.includes("/pulls/9/comments"))[0]?.headers.get("authorization"))
      .toBe("Bearer secret-token");
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
        if (request.url.endsWith("/pulls/9")) return Response.json({
          number: 9,
          html_url: "https://github.com/acme/app/pull/9",
          base: { ref: "develop" },
          head: { ref: "agent/issue-7" },
          body: "Closes #7",
        });
        return Response.json(issue(7));
      },
    });

    expect((await client.getIssue("acme/app", 7)).labels).toEqual(["bug", "agent:ready"]);
    expect(await client.getPullRequest("acme/app", 9)).toEqual({
      number: 9,
      url: "https://github.com/acme/app/pull/9",
      base: "develop",
      head: "agent/issue-7",
      body: "Closes #7",
    });
    expect(await client.getPullRequestDiff("acme/app", 9)).toStartWith("diff --git");
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
    expect(creates).toHaveLength(5);
    expect(updates).toHaveLength(1);
    expect(await Promise.all(creates.map((request) => request.clone().json())))
      .toContainEqual(expect.objectContaining({ name: config.ISSUE_HUMAN_REVIEW_LABEL }));
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
});

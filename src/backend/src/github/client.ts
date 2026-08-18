import { z } from "zod";

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.url(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string().nullable() })])),
  pull_request: z.unknown().optional(),
});

const repositorySchema = z.object({ clone_url: z.url() });
const labelSchema = z.object({ name: z.string(), color: z.string().optional(), description: z.string().nullable().optional() });
const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string() }),
  body: z.string().nullable(),
});

const parentIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.url(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().nullable(),
});

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type GitHubClientOptions = {
  token: string;
  apiUrl?: string;
  fetch?: Fetch;
};

export function createGitHubClient(options: GitHubClientOptions) {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetch = options.fetch ?? globalThis.fetch;

  async function request(path: string, init: RequestInit = {}, requestOptions: { text?: boolean; notFoundNull?: boolean } = {}) {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      if (requestOptions.notFoundNull && (response.status === 404 || response.status === 410)) return null;
      const body = await response.text();
      throw new Error(`GitHub API request failed (${response.status}): ${body.slice(0, 500).split(options.token).join("[REDACTED]")}`);
    }
    if (response.status === 204) return null;
    return requestOptions.text ? response.text() : response.json();
  }

  async function getRepository(fullName: string) {
    const repository = repositorySchema.parse(await request(`/repos/${fullName}`));
    return { cloneUrl: repository.clone_url };
  }

  async function listLabels(fullName: string) {
    const labels = [];
    for (let page = 1; ; page += 1) {
      const batch = z.array(labelSchema).parse(await request(
        `/repos/${fullName}/labels?per_page=100&page=${page}`,
      ));
      labels.push(...batch);
      if (batch.length < 100) return labels;
    }
  }

  async function ensureLabels(fullName: string, definitions: Array<{ name: string; color: string; description: string }>) {
    const existing = await listLabels(fullName);
    for (const definition of definitions) {
      const current = existing.find((label) => label.name === definition.name);
      if (!current) {
        try {
          await request(`/repos/${fullName}/labels`, {
            method: "POST",
            body: JSON.stringify(definition),
          });
        } catch (error) {
          if (!isUnprocessableEntity(error)) throw error;
          await updateLabel(fullName, definition);
        }
        continue;
      }
      if (current.description !== definition.description || current.color !== definition.color) {
        await updateLabel(fullName, definition);
      }
    }
  }

  async function updateLabel(fullName: string, definition: { name: string; color: string; description: string }) {
    await request(`/repos/${fullName}/labels/${encodeURIComponent(definition.name)}`, {
      method: "PATCH",
      body: JSON.stringify({ color: definition.color, description: definition.description }),
    });
  }

  async function listReadyIssues(fullName: string, label: string) {
    const issues = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        state: "open",
        labels: label,
        per_page: "100",
        page: String(page),
      });
      const batch = z.array(issueSchema).parse(await request(`/repos/${fullName}/issues?${query}`));
      issues.push(...batch.filter((issue) => issue.pull_request === undefined).map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        url: issue.html_url,
        labels: issue.labels.flatMap((value) => {
          const name = typeof value === "string" ? value : value.name;
          return name ? [name] : [];
        }),
      })));
      if (batch.length < 100) return issues;
    }
  }

  async function getIssue(fullName: string, issueNumber: number) {
    const issue = issueSchema.parse(await request(`/repos/${fullName}/issues/${issueNumber}`));
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      url: issue.html_url,
      labels: issue.labels.flatMap((value) => {
        const name = typeof value === "string" ? value : value.name;
        return name ? [name] : [];
      }),
    };
  }

  async function getParentIssue(fullName: string, issueNumber: number) {
    const parent = await request(
      `/repos/${fullName}/issues/${issueNumber}/parent`,
      {},
      { notFoundNull: true },
    );
    if (parent === null) return null;
    const parsed = parentIssueSchema.parse(parent);
    return {
      number: parsed.number,
      title: parsed.title,
      url: parsed.html_url,
      state: parsed.state,
      stateReason: parsed.state_reason,
    };
  }

  async function getPullRequest(fullName: string, pullRequestNumber: number) {
    const pullRequest = pullRequestSchema.parse(
      await request(`/repos/${fullName}/pulls/${pullRequestNumber}`),
    );
    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      base: pullRequest.base.ref,
      head: pullRequest.head.ref,
      body: pullRequest.body ?? "",
    };
  }

  async function getPullRequestDiff(fullName: string, pullRequestNumber: number) {
    return await request(`/repos/${fullName}/pulls/${pullRequestNumber}`, {
      headers: { Accept: "application/vnd.github.v3.diff" },
    }, { text: true }) as string;
  }

  async function setIssueLabels(fullName: string, issueNumber: number, labels: string[]) {
    await request(`/repos/${fullName}/issues/${issueNumber}/labels`, {
      method: "PUT",
      body: JSON.stringify({ labels }),
    });
  }

  async function addIssueComment(fullName: string, issueNumber: number, body: string) {
    await request(`/repos/${fullName}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  return {
    getRepository,
    ensureLabels,
    listReadyIssues,
    getIssue,
    getParentIssue,
    getPullRequest,
    getPullRequestDiff,
    setIssueLabels,
    addIssueComment,
  };
}

export type ParentIssue = {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  stateReason: string | null;
};

function isUnprocessableEntity(error: unknown) {
  return error instanceof Error && error.message.includes("GitHub API request failed (422)");
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;

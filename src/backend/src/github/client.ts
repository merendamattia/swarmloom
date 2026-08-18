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
const pullRequestListSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  title: z.string(),
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string() }),
  body: z.string().nullable(),
});
const pullRequestSchema = pullRequestListSchema.extend({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
});
const issueCommentSchema = z.object({
  body: z.string().nullable(),
  html_url: z.url(),
  user: z.object({ login: z.string() }).nullable().optional(),
  created_at: z.string().optional(),
});
const pullRequestReviewSchema = z.object({
  body: z.string().nullable(),
  state: z.string(),
  html_url: z.url(),
  user: z.object({ login: z.string() }).nullable().optional(),
  submitted_at: z.string().nullable().optional(),
});
const pullRequestCommentSchema = z.object({
  body: z.string().nullable(),
  path: z.string().nullable().optional(),
  line: z.number().int().nullable().optional(),
  original_line: z.number().int().nullable().optional(),
  html_url: z.url(),
  user: z.object({ login: z.string() }).nullable().optional(),
  created_at: z.string().optional(),
});
const checkRunsResponseSchema = z.object({
  check_runs: z.array(z.object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    html_url: z.url().nullable().optional(),
    details_url: z.url().nullable().optional(),
  })),
});
const commitStatusResponseSchema = z.object({
  state: z.string(),
  statuses: z.array(z.object({
    context: z.string(),
    state: z.string(),
    target_url: z.url().nullable().optional(),
  })),
});
const createdIssueSchema = z.object({ number: z.number().int().positive(), html_url: z.url() });

export type PullRequestCheck = {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
};

export type GitHubIssueContext = {
  issue: GitHubIssue;
  issueComments: Array<{
    body: string;
    url: string;
    user: string | null;
    createdAt: string | null;
  }>;
  pullRequests: Array<{
    number: number;
    title: string;
    url: string;
    base: string;
    head: string;
    body: string;
    diff: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    reviews: Array<{
      body: string;
      state: string;
      url: string;
      user: string | null;
      submittedAt: string | null;
    }>;
    comments: Array<{
      body: string;
      path: string | null;
      line: number | null;
      url: string;
      user: string | null;
      createdAt: string | null;
    }>;
  }>;
};

export type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
};

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type GitHubClientOptions = {
  token: string;
  apiUrl?: string;
  fetch?: Fetch;
};

export function createGitHubClient(options: GitHubClientOptions) {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetch = options.fetch ?? globalThis.fetch;

  async function request(path: string, init: RequestInit = {}, text = false) {
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
      const body = await response.text();
      throw new Error(`GitHub API request failed (${response.status}): ${body.slice(0, 500).split(options.token).join("[REDACTED]")}`);
    }
    if (response.status === 204) return null;
    return text ? response.text() : response.json();
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

  async function getPullRequest(fullName: string, pullRequestNumber: number) {
    const pullRequest = pullRequestSchema.parse(
      await request(`/repos/${fullName}/pulls/${pullRequestNumber}`),
    );
    return {
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.html_url,
      base: pullRequest.base.ref,
      head: pullRequest.head.ref,
      body: pullRequest.body ?? "",
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changed_files,
    };
  }

  async function getPullRequestDiff(fullName: string, pullRequestNumber: number) {
    return await request(`/repos/${fullName}/pulls/${pullRequestNumber}`, {
      headers: { Accept: "application/vnd.github.v3.diff" },
    }, true) as string;
  }

  async function getIssueContext(fullName: string, issueNumber: number, issueUrl: string): Promise<GitHubIssueContext> {
    const [issue, issueComments, pullRequests] = await Promise.all([
      getIssue(fullName, issueNumber),
      listIssueComments(fullName, issueNumber),
      listPullRequests(fullName),
    ]);
    const linkedPullRequests = pullRequests.filter((pullRequest) =>
      (pullRequest.body ?? "").includes(`#${issueNumber}`) || (pullRequest.body ?? "").includes(issueUrl));
    return {
      issue,
      issueComments,
      pullRequests: await Promise.all(linkedPullRequests.map(async (pullRequest) => {
        const [metadata, diff, reviews, comments] = await Promise.all([
          getPullRequest(fullName, pullRequest.number),
          getPullRequestDiff(fullName, pullRequest.number),
          listPullRequestReviews(fullName, pullRequest.number),
          listPullRequestComments(fullName, pullRequest.number),
        ]);
        return { ...metadata, diff, reviews, comments };
      })),
    };
  }

  async function listIssueComments(fullName: string, issueNumber: number) {
    const comments: GitHubIssueContext["issueComments"] = [];
    for (let page = 1; ; page += 1) {
      const batch = z.array(issueCommentSchema).parse(await request(
        `/repos/${fullName}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      ));
      comments.push(...batch.map((comment) => ({
        body: comment.body ?? "",
        url: comment.html_url,
        user: comment.user?.login ?? null,
        createdAt: comment.created_at ?? null,
      })));
      if (batch.length < 100) return comments;
    }
  }

  async function listPullRequests(fullName: string) {
    const pullRequests: Array<z.infer<typeof pullRequestListSchema>> = [];
    for (let page = 1; ; page += 1) {
      const batch = z.array(pullRequestListSchema).parse(await request(
        `/repos/${fullName}/pulls?state=all&per_page=100&page=${page}`,
      ));
      pullRequests.push(...batch);
      if (batch.length < 100) return pullRequests;
    }
  }

  async function listPullRequestReviews(fullName: string, pullRequestNumber: number) {
    const reviews: GitHubIssueContext["pullRequests"][number]["reviews"] = [];
    for (let page = 1; ; page += 1) {
      const batch = z.array(pullRequestReviewSchema).parse(await request(
        `/repos/${fullName}/pulls/${pullRequestNumber}/reviews?per_page=100&page=${page}`,
      ));
      reviews.push(...batch.map((review) => ({
        body: review.body ?? "",
        state: review.state,
        url: review.html_url,
        user: review.user?.login ?? null,
        submittedAt: review.submitted_at ?? null,
      })));
      if (batch.length < 100) return reviews;
    }
  }

  async function listPullRequestComments(fullName: string, pullRequestNumber: number) {
    const comments: GitHubIssueContext["pullRequests"][number]["comments"] = [];
    for (let page = 1; ; page += 1) {
      const batch = z.array(pullRequestCommentSchema).parse(await request(
        `/repos/${fullName}/pulls/${pullRequestNumber}/comments?per_page=100&page=${page}`,
      ));
      comments.push(...batch.map((comment) => ({
        body: comment.body ?? "",
        path: comment.path ?? null,
        line: comment.line ?? comment.original_line ?? null,
        url: comment.html_url,
        user: comment.user?.login ?? null,
        createdAt: comment.created_at ?? null,
      })));
      if (batch.length < 100) return comments;
    }
  }

  async function getPullRequestChecks(fullName: string, ref: string): Promise<PullRequestCheck[]> {
    const encodedRef = encodeURIComponent(ref);
    const [checkRuns, commitStatus] = await Promise.all([
      request(`/repos/${fullName}/commits/${encodedRef}/check-runs`),
      request(`/repos/${fullName}/commits/${encodedRef}/status`),
    ]);
    const runs = checkRunsResponseSchema.parse(checkRuns).check_runs.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      url: check.html_url ?? check.details_url ?? null,
    }));
    const status = commitStatusResponseSchema.parse(commitStatus);
    const statuses = status.statuses.length > 0 ? status.statuses : [{
      context: "commit-status",
      state: status.state,
      target_url: null,
    }];
    return [...runs, ...statuses.map((item) => ({
      name: item.context,
      status: item.state === "pending" ? "in_progress" : "completed",
      conclusion: item.state === "pending" ? null : item.state === "success" ? "success" : item.state,
      url: item.target_url ?? null,
    }))];
  }

  async function createIssue(fullName: string, title: string, body: string, labels: string[]) {
    const issue = createdIssueSchema.parse(await request(`/repos/${fullName}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body, labels }),
    }));
    return { number: issue.number, url: issue.html_url };
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
    getPullRequest,
    getPullRequestDiff,
    getIssueContext,
    getPullRequestChecks,
    createIssue,
    setIssueLabels,
    addIssueComment,
  };
}

function isUnprocessableEntity(error: unknown) {
  return error instanceof Error && error.message.includes("GitHub API request failed (422)");
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;

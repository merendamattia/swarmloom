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
  body: z.string().nullable(),
  merged_at: z.string().nullable().optional(),
  updated_at: z.string().optional(),
  state: z.string().optional(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable().optional() }),
});
const pullRequestSchema = pullRequestListSchema.extend({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
  state: z.string(),
  merged: z.boolean().nullable().optional(),
  head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable().optional() }),
});
const comparisonSchema = z.object({
  ahead_by: z.number().int().nonnegative(),
  base_commit: z.object({ commit: z.object({ tree: z.object({ sha: z.string() }) }) }),
  merge_base_commit: z.object({ commit: z.object({ committer: z.object({ date: z.string() }) }) }),
});
const branchSchema = z.object({ commit: z.object({ commit: z.object({ tree: z.object({ sha: z.string() }) }) }) });
const labelListSchema = z.array(z.union([z.string(), z.object({ name: z.string().nullable() })]));
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
const createdIssueSchema = z.object({ number: z.number().int().positive(), html_url: z.url() });

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
    headSha: string;
    state: string;
    merged: boolean;
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

export function isOpenPullRequest(pullRequest: { state: string; merged: boolean }) {
  return pullRequest.state.toLowerCase() === "open" && !pullRequest.merged;
}

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

  async function listPullRequests(fullName: string, label: string) {
    const pullRequests = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        state: "open",
        labels: label,
        per_page: "100",
        page: String(page),
      });
      const batch = z.array(issueSchema).parse(await request(`/repos/${fullName}/issues?${query}`));
      pullRequests.push(...batch.filter((issue) => issue.pull_request !== undefined).map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        url: issue.html_url,
        labels: issue.labels.flatMap((value) => {
          const name = typeof value === "string" ? value : value.name;
          return name ? [name] : [];
        }),
      })));
      if (batch.length < 100) return pullRequests;
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

  async function findIssueByMarker(fullName: string, marker: string, signal?: AbortSignal) {
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({ state: "all", per_page: "100", page: String(page) });
      const batch = z.array(issueSchema).parse(await request(`/repos/${fullName}/issues?${query}`, { signal }));
      const issue = batch.find((candidate) => candidate.pull_request === undefined && candidate.body?.includes(marker));
      if (issue) return { number: issue.number, url: issue.html_url };
      if (batch.length < 100) return undefined;
    }
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
      headSha: pullRequest.head.sha,
      state: pullRequest.state,
      merged: pullRequest.merged === true,
      body: pullRequest.body ?? "",
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changed_files,
    };
  }

  async function compareBranches(fullName: string, base: string, head: string) {
    const comparison = comparisonSchema.parse(await request(`/repos/${fullName}/compare/${base}...${head}`));
    if (comparison.ahead_by === 0) return { aheadBy: 0, hasChanges: false, mergeBaseDate: comparison.merge_base_commit.commit.committer.date };
    const headBranch = branchSchema.parse(await request(`/repos/${fullName}/branches/${head}`));
    return {
      aheadBy: comparison.ahead_by,
      hasChanges: comparison.base_commit.commit.tree.sha !== headBranch.commit.commit.tree.sha,
      mergeBaseDate: comparison.merge_base_commit.commit.committer.date,
    };
  }

  async function lastMergedPromotionDate(fullName: string) {
    let latest: string | null = null;
    for (let page = 1; ; page += 1) {
      const owner = fullName.split("/")[0];
      const query = new URLSearchParams({ state: "closed", base: "main", head: `${owner}:develop`, sort: "updated", direction: "desc", per_page: "100", page: String(page) });
      const batch = z.array(pullRequestListSchema).parse(await request(`/repos/${fullName}/pulls?${query}`));
      for (const pullRequest of batch) {
        if (pullRequest.head.repo?.full_name === fullName && pullRequest.merged_at && (latest === null || pullRequest.merged_at > latest)) {
          latest = pullRequest.merged_at;
        }
      }
      const oldestUpdate = batch.at(-1)?.updated_at;
      if (batch.length < 100 || (latest !== null && oldestUpdate !== undefined && oldestUpdate < latest)) return latest;
    }
  }

  async function listMergedPullRequests(fullName: string, base: string, since: string) {
    const merged: Array<{ number: number; body: string; mergedAt: string }> = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({ state: "closed", base, sort: "updated", direction: "desc", per_page: "100", page: String(page) });
      const batch = z.array(pullRequestListSchema).parse(await request(`/repos/${fullName}/pulls?${query}`));
      for (const pullRequest of batch) {
        if (pullRequest.merged_at && pullRequest.merged_at >= since) {
          merged.push({ number: pullRequest.number, body: pullRequest.body ?? "", mergedAt: pullRequest.merged_at });
        }
      }
      const oldestUpdate = batch.at(-1)?.updated_at;
      if (batch.length < 100 || (oldestUpdate !== undefined && oldestUpdate < since)) return merged;
    }
  }

  async function findPromotionPullRequest(fullName: string) {
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({ state: "open", base: "main", per_page: "100", page: String(page) });
      const batch = z.array(pullRequestListSchema).parse(await request(`/repos/${fullName}/pulls?${query}`));
      const promotion = batch.find((pullRequest) => pullRequest.head.ref === "develop" && pullRequest.head.repo?.full_name === fullName);
      if (promotion) return { number: promotion.number, body: promotion.body ?? "" };
      if (batch.length < 100) return null;
    }
  }

  async function createPromotionPullRequest(fullName: string, body: string) {
    await request(`/repos/${fullName}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: "chore: promote develop to main", head: "develop", base: "main", body }),
    });
  }

  async function updatePullRequestBody(fullName: string, number: number, body: string) {
    await request(`/repos/${fullName}/pulls/${number}`, { method: "PATCH", body: JSON.stringify({ body }) });
  }

  async function getPullRequestDiff(fullName: string, pullRequestNumber: number) {
    return await request(`/repos/${fullName}/pulls/${pullRequestNumber}`, {
      headers: { Accept: "application/vnd.github.v3.diff" },
    }, true) as string;
  }

  async function getPullRequestLabels(fullName: string, pullRequestNumber: number) {
    const labels = labelListSchema.parse(
      await request(`/repos/${fullName}/issues/${pullRequestNumber}/labels`),
    );
    return labels.flatMap((value) => {
      const name = typeof value === "string" ? value : value.name;
      return name ? [name] : [];
    });
  }

  async function setPullRequestLabels(fullName: string, pullRequestNumber: number, labels: string[]) {
    await request(`/repos/${fullName}/issues/${pullRequestNumber}/labels`, {
      method: "PUT",
      body: JSON.stringify({ labels }),
    });
  }

  async function getIssueContext(fullName: string, issueNumber: number, issueUrl: string, pullRequestNumber?: number): Promise<GitHubIssueContext> {
    const [issue, issueComments, pullRequests] = await Promise.all([
      getIssue(fullName, issueNumber),
      listIssueComments(fullName, issueNumber),
      pullRequestNumber !== undefined ? [pullRequestNumber] : [],
    ]);
    return {
      issue,
      issueComments,
      pullRequests: await Promise.all(pullRequests.map(async (number) => {
        const [metadata, diff, reviews, comments] = await Promise.all([
          getPullRequest(fullName, number),
          getPullRequestDiff(fullName, number),
          listPullRequestReviews(fullName, number),
          listPullRequestComments(fullName, number),
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

  async function createIssue(fullName: string, title: string, body: string, labels: string[], signal?: AbortSignal) {
    const issue = createdIssueSchema.parse(await request(`/repos/${fullName}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body, labels }),
      signal,
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
    listPullRequests,
    getIssue,
    findIssueByMarker,
    getPullRequest,
    compareBranches,
    lastMergedPromotionDate,
    listMergedPullRequests,
    findPromotionPullRequest,
    createPromotionPullRequest,
    updatePullRequestBody,
    getPullRequestDiff,
    getPullRequestLabels,
    setPullRequestLabels,
    getIssueContext,
    createIssue,
    setIssueLabels,
    addIssueComment,
  };
}

function isUnprocessableEntity(error: unknown) {
  return error instanceof Error && error.message.includes("GitHub API request failed (422)");
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;

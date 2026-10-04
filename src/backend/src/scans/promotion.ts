import type { GitHubClient } from "../github/client.ts";

type PromotionGitHub = Pick<GitHubClient,
  "compareBranches" | "lastMergedPromotionDate" | "listMergedPullRequests" | "findPromotionPullRequest" |
  "createPromotionPullRequest" | "updatePullRequestBody">;

type PromotionDependencies = {
  github: PromotionGitHub;
  managedIssue: (prNumber: number) => Promise<number | null>;
  withLock: (action: () => Promise<void>) => Promise<void>;
  warn: (message: string) => Promise<void>;
};

const section = "## Issues included in this promotion";
const issueReference = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\b/gi;

function referencedIssues(body: string) {
  return [...body.matchAll(issueReference)].map((match) => Number(match[1]));
}

export function promotionBody(body: string, issues: number[]) {
  const heading = /^## Issues included in this promotion[ \t]*$/m;
  const found = heading.exec(body);
  if (!found) {
    const prefix = body.trimEnd();
    const existing = new Set(referencedIssues(prefix));
    const missing = [...new Set(issues)].filter((issue) => !existing.has(issue));
    return `${prefix ? `${prefix}\n\n` : ""}${section}\n\n${missing.sort((a, b) => a - b).map((issue) => `Closes #${issue}`).join("\n")}`;
  }
  const start = found.index + found[0].length;
  const following = /^#{1,6} .+$/gm;
  following.lastIndex = start;
  const next = following.exec(body);
  const end = next?.index ?? body.length;
  const managed = body.slice(start, end);
  const outside = `${body.slice(0, found.index)}${body.slice(end)}`;
  const managedIssues = new Set(referencedIssues(managed));
  for (const issue of issues) managedIssues.add(issue);
  const outsideIssues = new Set(referencedIssues(outside));
  const lines = [...managedIssues].filter((issue) => !outsideIssues.has(issue)).sort((a, b) => a - b)
    .map((issue) => `Closes #${issue}`).join("\n");
  return `${body.slice(0, start)}\n\n${lines}${next ? `\n\n${body.slice(end)}` : ""}`;
}

export async function promoteDevelop(fullName: string, { github, managedIssue, withLock, warn }: PromotionDependencies) {
  const { hasChanges, mergeBaseDate } = await github.compareBranches(fullName, "main", "develop");
  if (!hasChanges) return;

  const lastPromotion = await github.lastMergedPromotionDate(fullName);
  const since = lastPromotion && lastPromotion > mergeBaseDate ? lastPromotion : mergeBaseDate;
  const merged = (await github.listMergedPullRequests(fullName, "develop", since))
    .filter((pullRequest) => lastPromotion === null || pullRequest.mergedAt > lastPromotion);
  if (merged.length === 0) return;
  const issues = new Set<number>();
  for (const pullRequest of merged) {
    const managed = await managedIssue(pullRequest.number);
    const referenced = referencedIssues(pullRequest.body);
    if (managed !== null) issues.add(managed);
    for (const issue of referenced) issues.add(issue);
    if (managed === null && referenced.length === 0) {
      await warn(`No issue reference found for merged pull request ${fullName}#${pullRequest.number}`);
    }
  }

  await withLock(async () => {
    const current = await github.findPromotionPullRequest(fullName);
    if (current) {
      const body = promotionBody(current.body, [...issues]);
      if (body !== current.body) await github.updatePullRequestBody(fullName, current.number, body);
      return;
    }
    const body = promotionBody("Automated promotion PR created by Swarmloom for changes merged into `develop`.", [...issues]);
    try {
      await github.createPromotionPullRequest(fullName, body);
    } catch (error) {
      // GitHub rejects a second open PR for the same head/base pair. Re-read after that race.
      const created = await github.findPromotionPullRequest(fullName);
      if (!created) throw error;
      const updated = promotionBody(created.body, [...issues]);
      if (updated !== created.body) await github.updatePullRequestBody(fullName, created.number, updated);
    }
  });
}

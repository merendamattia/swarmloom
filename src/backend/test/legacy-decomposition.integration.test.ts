import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prisma } from "../src/core/db.ts";
import { parseConfig } from "../src/core/config-schema.ts";
import type { GitHubClient } from "../src/github/client.ts";
import { jobRepository } from "../src/repositories/jobs.ts";
import { reconcileLegacyDecompositionJobs } from "../src/worker/legacy-decomposition.ts";

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("legacy decomposition upgrade", () => {
  const environment = "test";
  const issueNumber = Math.floor(Math.random() * 100_000) + 100_000;
  const config = parseConfig({
    APP_ENV: environment,
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY,
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORIES: "test/legacy-decomposition",
    AGENT_PROVIDER: "codex",
  });
  let repositoryId = "";

  beforeAll(async () => {
    repositoryId = (await prisma.repository.create({
      data: { fullName: `test/legacy-${crypto.randomUUID()}`, cloneUrl: "https://github.com/test/legacy.git" },
    })).id;
  });

  afterAll(async () => {
    await prisma.job.deleteMany({ where: { repositoryId } });
    await prisma.repository.delete({ where: { id: repositoryId } });
  });

  test("migrates an unfinished job and reconciles its issue once after an interrupted comment", async () => {
    const job = await jobRepository.tryCreateQueued({
      repositoryId,
      environment,
      jobType: "IMPLEMENTATION",
      subjectType: "ISSUE",
      issueNumber,
      issueTitle: "Legacy issue",
      issueUrl: `https://github.com/test/legacy/issues/${issueNumber}`,
      issueBody: "Legacy body",
      branchName: `agent/decompose-${issueNumber}`,
      baselineCommit: "a".repeat(40),
      provider: "CODEX",
      model: "gpt-6-luna",
    });
    await prisma.job.update({ where: { id: job!.id }, data: { jobType: "DECOMPOSITION" } });
    const migration = await Bun.file(new URL("../prisma/migrations/0016_remove_decomposition_workflow/migration.sql", import.meta.url)).text();
    const update = migration.match(/UPDATE "job"[\s\S]*?;\n/)?.[0];
    expect(update).toBeDefined();
    await prisma.$executeRawUnsafe(update!);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job!.id } })).toMatchObject({
      status: "BLOCKED",
      activeIssueKey: null,
      legacyDecompositionReconciledAt: null,
    });

    let labels = ["bug", config.ISSUE_WORKING_LABEL];
    const comments: string[] = [];
    let failComment = true;
    const github = {
      getIssueContext: async () => ({ issue: { labels }, issueComments: comments.map((body) => ({ body })) }),
      setIssueLabels: async (_repository: string, _number: number, next: string[]) => { labels = next; },
      addIssueComment: async (_repository: string, _number: number, body: string) => {
        if (failComment) { failComment = false; throw new Error("temporary GitHub failure"); }
        comments.push(body);
      },
    } as unknown as GitHubClient;

    await reconcileLegacyDecompositionJobs(config, github);
    expect(labels).toEqual(["bug", config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL]);
    expect(comments).toHaveLength(0);

    await reconcileLegacyDecompositionJobs(config, github);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("decomposition workflow was removed");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job!.id } })).legacyDecompositionReconciledAt).not.toBeNull();

    // A lost database acknowledgement must not duplicate a GitHub comment.
    await prisma.job.update({ where: { id: job!.id }, data: { legacyDecompositionReconciledAt: null } });
    await reconcileLegacyDecompositionJobs(config, github);
    expect(comments).toHaveLength(1);
  });
});

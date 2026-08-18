import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJobWorktree,
  MissingDevelopBranchError,
  syncRepository,
} from "../src/git/repositories.ts";
import { runGit } from "../src/git/run-git.ts";

describe("target repository preparation", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  test("fetches the latest origin/develop and creates a worktree at that exact commit", async () => {
    const fixture = await createRemote("develop");
    const dataDir = join(fixture.root, "worker-data");
    const first = await syncRepository({
      dataDir,
      fullName: "acme/example",
      cloneUrl: fixture.remote,
    });

    const latest = await commitAndPush(fixture.seed, "second");
    const synced = await syncRepository({
      dataDir,
      fullName: "acme/example",
      cloneUrl: fixture.remote,
    });
    expect(synced.baselineCommit).not.toBe(first.baselineCommit);
    expect(synced.baselineCommit).toBe(latest);

    const worktreePath = join(dataDir, "worktrees", "job-1");
    await createJobWorktree({
      repositoryPath: synced.localPath,
      worktreePath,
      branchName: "agent/issue-42-test",
      baselineCommit: synced.baselineCommit,
    });
    expect(await runGit(["rev-parse", "HEAD"], worktreePath)).toBe(latest);
    expect(await runGit(["branch", "--show-current"], worktreePath)).toBe("agent/issue-42-test");
  });

  test("rejects a repository without origin/develop instead of falling back to main", async () => {
    const fixture = await createRemote("main");

    await expect(syncRepository({
      dataDir: join(fixture.root, "worker-data"),
      fullName: "acme/main-only",
      cloneUrl: fixture.remote,
    })).rejects.toBeInstanceOf(MissingDevelopBranchError);
  });

  async function createRemote(branch: "develop" | "main") {
    const root = await mkdtemp(join(tmpdir(), "github-agent-worker-git-"));
    temporaryDirectories.push(root);
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    await mkdir(seed);
    await runGit(["init", "--bare", remote], root);
    await runGit(["init", "-b", branch], seed);
    await runGit(["config", "user.name", "Worker Test"], seed);
    await runGit(["config", "user.email", "worker@example.test"], seed);
    await Bun.write(join(seed, "README.md"), "first\n");
    await runGit(["add", "README.md"], seed);
    await runGit(["commit", "-m", "first"], seed);
    await runGit(["remote", "add", "origin", remote], seed);
    await runGit(["push", "-u", "origin", branch], seed);
    return { root, remote, seed };
  }

  async function commitAndPush(seed: string, content: string) {
    await Bun.write(join(seed, "README.md"), `${content}\n`);
    await runGit(["add", "README.md"], seed);
    await runGit(["commit", "-m", content], seed);
    await runGit(["push", "origin", "develop"], seed);
    return runGit(["rev-parse", "HEAD"], seed);
  }
});

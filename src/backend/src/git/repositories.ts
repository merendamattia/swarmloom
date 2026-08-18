import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { GitCommandError, runGit } from "./run-git.ts";

export class MissingDevelopBranchError extends Error {
  constructor(readonly repository: string) {
    super(`${repository} does not have the required remote branch origin/develop`);
  }
}

type SyncRepositoryInput = {
  dataDir: string;
  fullName: string;
  cloneUrl: string;
  gitEnvironment?: Record<string, string | undefined>;
};

export async function syncRepository(input: SyncRepositoryInput) {
  const localPath = repositoryPath(input.dataDir, input.fullName);
  await mkdir(dirname(localPath), { recursive: true });
  if (!existsSync(resolve(localPath, ".git"))) {
    await runGit(["clone", "--no-checkout", "--origin", "origin", input.cloneUrl, localPath], undefined,
      input.gitEnvironment);
  }

  await runGit(["remote", "set-url", "origin", input.cloneUrl], localPath, input.gitEnvironment);
  try {
    await runGit(["ls-remote", "--exit-code", "origin", "refs/heads/develop"], localPath,
      input.gitEnvironment);
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 2) {
      throw new MissingDevelopBranchError(input.fullName);
    }
    throw error;
  }
  await runGit([
    "fetch",
    "--prune",
    "origin",
    "+refs/heads/develop:refs/remotes/origin/develop",
  ], localPath, input.gitEnvironment);
  const baselineCommit = await runGit(["rev-parse", "--verify", "origin/develop^{commit}"], localPath,
    input.gitEnvironment);
  return { localPath, baselineCommit };
}

type CreateWorktreeInput = {
  repositoryPath: string;
  worktreePath: string;
  branchName: string;
  baselineCommit: string;
  gitEnvironment?: Record<string, string | undefined>;
};

export async function createJobWorktree(input: CreateWorktreeInput) {
  if (existsSync(input.worktreePath)) throw new Error(`Worktree path already exists: ${input.worktreePath}`);
  await mkdir(dirname(input.worktreePath), { recursive: true });
  await runGit(["check-ref-format", "--branch", input.branchName], input.repositoryPath,
    input.gitEnvironment);
  await runGit([
    "worktree",
    "add",
    "-b",
    input.branchName,
    input.worktreePath,
    input.baselineCommit,
  ], input.repositoryPath, input.gitEnvironment);
  return input.worktreePath;
}

export function repositoryPath(dataDir: string, fullName: string) {
  const [owner, name, extra] = fullName.split("/");
  if (!owner || !name || extra || [owner, name].includes(".") || [owner, name].includes("..")) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  const root = resolve(dataDir, "repositories");
  const path = resolve(root, owner, name);
  if (!path.startsWith(`${root}${sep}`)) throw new Error(`Repository path escapes data root: ${fullName}`);
  return path;
}

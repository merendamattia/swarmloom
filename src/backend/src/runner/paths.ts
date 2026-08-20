import { resolve, sep } from "node:path";

export function safeWorktreePath(dataDirectory: string, jobId: string) {
  const root = resolve(dataDirectory, "worktrees");
  const path = resolve(root, jobId);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("Job worktree path escapes data directory");
  return path;
}

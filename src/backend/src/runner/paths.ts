import { resolve, sep } from "node:path";

export function safeWorktreePath(dataDirectory: string, jobId: string, attempts: number) {
  const root = resolve(dataDirectory, "worktrees");
  const path = resolve(root, `${jobId}-attempt-${attempts}`);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("Job worktree path escapes data directory");
  return path;
}

export class GitCommandError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stderr: string,
    readonly args: string[],
  ) {
    super(`git ${args[0] ?? "command"} failed with exit code ${exitCode}: ${stderr || "no error output"}`);
  }
}

export async function runGit(
  args: string[],
  cwd?: string,
  environment: Record<string, string | undefined> = {},
) {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...Bun.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new GitCommandError(exitCode, stderr.trim().slice(0, 2_000), args);
  return stdout.trim();
}

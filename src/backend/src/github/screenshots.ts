import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { redactSecrets } from "../core/secrets.ts";

export async function commentWithScreenshots(options: {
  token: string;
  apiUrl: string;
  repository: string;
  issueNumber: number;
  body: string;
  worktreePath?: string;
}) {
  const references = new Set<string>();
  Bun.markdown.render(options.body, { image: (_alt, { src }) => {
    if (/^\.agent-work\/screenshots\/[a-zA-Z0-9_-]+\.png$/.test(src)) references.add(src);
    return "";
  } });
  const files = [...references];
  if (!files.length) return false;
  if (!options.worktreePath) throw new Error("Screenshot comment has no assigned worktree");
  if (files.length > 50) throw new Error("A comment supports at most 50 screenshots");
  const worktree = await realpath(options.worktreePath);
  const root = resolve(worktree, ".agent-work/screenshots");
  for (const file of files) {
    const path = await realpath(resolve(worktree, file));
    if (!path.startsWith(`${root}${sep}`)) throw new Error("Screenshot is outside the screenshot directory");
    const info = await stat(path);
    if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error("Screenshot must be a regular PNG file of at most 10 MiB");
    const signature = Buffer.from(await Bun.file(path).slice(0, 8).arrayBuffer());
    if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Screenshot must contain a valid PNG");
  }
  const host = new URL(options.apiUrl).hostname.replace(/^api\./, "");
  const environment = { ...process.env, GH_TOKEN: options.token };
  const child = Bun.spawn([
    "gh", "issue", "comment", String(options.issueNumber), "--repo", `${host}/${options.repository}`,
    "--body-file", "-", ...files.flatMap((file) => ["--attach", file]),
  ], { cwd: worktree, env: environment, stdin: "pipe", stdout: "ignore", stderr: "pipe", timeout: 60_000 });
  child.stdin.write(options.body);
  child.stdin.end();
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`Screenshot comment failed: ${redactSecrets(stderr, environment).slice(-2_000)}`);
  return true;
}

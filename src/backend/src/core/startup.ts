import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Config } from "./config-schema.ts";
import { prisma } from "./db.ts";
import { redactSecrets } from "./secrets.ts";
import { createGitHubClient } from "../github/client.ts";
import { agentLabelDefinitions } from "../github/labels.ts";
import { loadAgentInstructions } from "../runtime/instructions.ts";
import { providerLoginCommand } from "./provider-auth.ts";
import { readApplicationVersion } from "./version.ts";

export async function validateStartup(config: Config) {
  const repositories = resolve(config.DATA_DIR, "repositories");
  const worktrees = resolve(config.DATA_DIR, "worktrees");
  await Promise.all([mkdir(repositories, { recursive: true }), mkdir(worktrees, { recursive: true })]);
  await Promise.all([access(repositories, constants.R_OK | constants.W_OK), access(worktrees, constants.R_OK | constants.W_OK)]);
  await Promise.all([
    loadAgentInstructions(config.AGENT_RUNTIME_DIR),
    prisma.$queryRaw`SELECT 1`,
  ]);

  const [gitVersion, ghVersion, providerVersion, version] = await Promise.all([
    command(["git", "--version"]),
    command(["gh", "--version"]),
    command([config.AGENT_PROVIDER, "--version"]),
    readApplicationVersion(),
  ]);
  await command(["gh", "auth", "status"], { ...process.env, GH_TOKEN: config.GITHUB_TOKEN });
  const github = createGitHubClient({ token: config.GITHUB_TOKEN, apiUrl: config.GITHUB_API_URL });
  await Promise.all(config.githubRepositories.map((repository) =>
    github.ensureLabels(repository, agentLabelDefinitions(config))));
  return {
    database: "ok",
    dataDirectory: resolve(config.DATA_DIR),
    runtimeDirectory: resolve(config.AGENT_RUNTIME_DIR),
    gitVersion: firstLine(gitVersion),
    ghVersion: firstLine(ghVersion),
    provider: config.AGENT_PROVIDER,
    providerVersion: firstLine(providerVersion),
    version,
  };
}

export async function checkProviderAuthentication(provider: Config["AGENT_PROVIDER"]) {
  const authenticated = provider === "codex"
    ? await command(["codex", "login", "status"]).then(() => true, () => false)
    : hasOpenCodeLogin();
  return {
    status: authenticated ? "authenticated" as const : "required" as const,
    loginCommand: providerLoginCommand(provider),
  };
}

async function command(args: string[], environment = process.env) {
  const child = Bun.spawn(args, { env: environment, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 10_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  if (exitCode !== 0) {
    throw new Error(redactSecrets(`${args[0]} startup check failed: ${stderr || stdout}`.trim()).slice(0, 2_000));
  }
  return stdout || stderr;
}

function hasOpenCodeLogin() {
  const roots = [
    process.env.XDG_DATA_HOME,
    process.env.HOME && resolve(process.env.HOME, ".local/share"),
  ].filter(Boolean) as string[];
  return roots.some((root) => Bun.file(resolve(root, "opencode/auth.json")).size > 0);
}

function firstLine(value: string) {
  return value.trim().split("\n")[0] ?? "unknown";
}

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadAgentInstructions } from "../src/runtime/instructions.ts";

const runtime = resolve(import.meta.dir, "../../../agent-runtime");

describe("canonical agent runtime", () => {
  test("loads the same global instructions for every execution phase", async () => {
    const instructions = await loadAgentInstructions(runtime);
    expect(instructions).toContain("global instructions");
    expect(instructions).toBe(await loadAgentInstructions(runtime));
    expect(instructions).not.toContain("agents/");
    expect(instructions).not.toContain("skills/");
    for (const skill of [
      "Conventional commits",
      "Ponytail",
      "Build production web app",
      "Humanizer",
      "Caveman",
      "Solid",
      "Vercel composition patterns",
    ]) expect(instructions).toContain(skill);
    expect(instructions).not.toContain("Review Agent");
    expect(instructions).toContain("gh issue view");
    expect(instructions).toContain("gh pr view");
    expect(instructions).toContain("headRefOid");
    expect(instructions).toContain("repos/<owner>/<repo>/pulls/<pr-number>/reviews");
    expect(instructions).toContain("-f head_sha=<head-sha>");
    expect(instructions).toContain("repos/<owner>/<repo>/actions/runs/<run-id>/jobs");
    expect(instructions).toContain("gh run view <run-id>");
    expect(instructions).toContain("--log-failed");
    expect(instructions).toContain("do not require `Checks: read`");
  });

  test("forbids pushing to main or develop and resolves pull request conflicts", async () => {
    const instructions = await loadAgentInstructions(runtime);
    expect(instructions).toContain("never push to `main` or `develop`");
    expect(instructions).toContain("Push only the current fix branch");
    expect(instructions).toContain("conflicting files");
    expect(instructions).toContain("resolve");
    expect(instructions).toContain("mergeable");
  });

  test("requires real newlines in GitHub Markdown bodies", async () => {
    const instructions = await loadAgentInstructions(runtime);
    expect(instructions).toContain("real line-feed characters");
    expect(instructions).toContain("temporary file or a quoted heredoc");
    expect(instructions).toContain("Do not");
    expect(instructions).toContain("JSON-style `\\n` inside a shell-quoted argument");
    expect(instructions).toContain("--body-file");
    expect(instructions).toContain("Intended section breaks");
    expect(instructions).toContain("Keep intentional fenced code blocks intact");
  });

  test("requires running every ci.yaml command before committing", async () => {
    const instructions = await loadAgentInstructions(runtime);
    for (const cmd of [
      "bun install --frozen-lockfile",
      "pip install -r requirements.txt",
      "pre-commit run --all-files",
      "bun run db:generate",
      "bun run db:deploy",
      "bun run typecheck",
      "bun run lint",
      "bun run test",
      "bun run build",
    ]) expect(instructions).toContain(cmd);
    expect(instructions).toContain("Do not skip any of them");
    expect(instructions).toContain("RUN_INTEGRATION=1");
    expect(instructions).toContain("CHANGELOG.md");
    expect(instructions).toContain("swarm-test-services start");
    expect(instructions).toContain("swarm-test-services stop");
    expect(instructions).toContain("no Docker inside the worker");
    for (const cache of ["BUN_INSTALL_CACHE_DIR", "PIP_CACHE_DIR", "PRE_COMMIT_HOME"]) {
      expect(instructions).toContain(cache);
    }
    expect(instructions).toContain("BUN_INSTALL_IGNORE_SCRIPTS=1");
    expect(instructions).toContain("msgpackr");
    expect(instructions).toContain("do not reinstall it");
    for (const tool of ["bun", "python3", "pip", "pre-commit", "gcc", "g++", "make", "pkg-config", "git", "gh", "psql", "redis-cli"]) {
      expect(instructions).toContain(`\`${tool}\``);
    }
  });

  test("tells agents to finish simple requests directly", async () => {
    const instructions = await loadAgentInstructions(runtime);
    expect(instructions).toContain("do not install tools or dependencies just to validate a simple request");
    expect(instructions).toContain("stop as soon as the acceptance criteria are met");
  });

  test("describes the plain text response file contract", async () => {
    const instructions = await loadAgentInstructions(runtime);
    expect(instructions).toContain("Response file");
    expect(instructions).toContain("Outcome: implemented");
    expect(instructions).toContain("Review: pass");
  });

  test("uses the agent runtime baked into the production image", async () => {
    const root = resolve(runtime, "..");
    const [dockerfile, compose] = await Promise.all([
      Bun.file(resolve(root, "Dockerfile")).text(),
      Bun.file(resolve(root, "docker-compose.production.yaml")).text(),
    ]);

    expect(dockerfile).toContain("COPY agent-runtime agent-runtime");
    expect(compose).not.toContain("AGENT_RUNTIME_HOST_PATH");
    expect(compose).not.toContain(":/app/agent-runtime");
  });
});

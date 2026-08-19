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
  });

  test("forbids pushing to main or develop and resolves pull request conflicts", async () => {
    const instructions = await loadAgentInstructions(runtime);
    expect(instructions).toContain("never push to `main` or `develop`");
    expect(instructions).toContain("Push only the current fix branch");
    expect(instructions).toContain("conflicting files");
    expect(instructions).toContain("resolve");
    expect(instructions).toContain("mergeable");
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

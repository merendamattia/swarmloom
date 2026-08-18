import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadAgentInstructions, resultSchemaPath } from "../src/runtime/instructions.ts";

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

  test("tells agents to finish simple requests directly", async () => {
    const instructions = await loadAgentInstructions(runtime);
    expect(instructions).toContain("do not install tools or dependencies just to validate a simple request");
    expect(instructions).toContain("stop as soon as the acceptance criteria are met");
  });

  test("selects the correct machine-readable result schema", () => {
    expect(resultSchemaPath(runtime, "reviewer")).toEndWith("review-result.schema.json");
    expect(resultSchemaPath(runtime, "decomposer")).toEndWith("decomposition-result.schema.json");
    expect(resultSchemaPath(runtime, "issue-worker")).toEndWith("job-result.schema.json");
  });

  test("keeps Codex schemas flat and fully required", async () => {
    for (const role of ["issue-worker", "decomposer", "reviewer"] as const) {
      const schema = await Bun.file(resultSchemaPath(runtime, role)).text();
      expect(schema).not.toContain('"oneOf"');
      const parsed = JSON.parse(schema) as { properties: Record<string, unknown>; required: string[] };
      expect(parsed.required).toEqual(Object.keys(parsed.properties));
    }
  });
});

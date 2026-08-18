import { resolve } from "node:path";
import type { AgentRole } from "../providers/types.ts";

async function requiredFile(path: string) {
  const file = Bun.file(path);
  if (!await file.exists()) throw new Error(`Missing agent runtime file: ${path}`);
  return file.text();
}

export async function loadAgentInstructions(runtimeDirectory: string) {
  const root = resolve(runtimeDirectory);
  return (await Promise.all([
    requiredFile(resolve(root, "instructions/global-skills.md")),
    requiredFile(resolve(root, "instructions/global.md")),
  ])).join("\n\n---\n\n");
}

export function resultSchemaPath(runtimeDirectory: string, role: AgentRole) {
  const schema = role === "reviewer" || role === "pull-request"
    ? "review-result.schema.json"
    : role === "decomposer" ? "decomposition-result.schema.json" : "job-result.schema.json";
  return resolve(runtimeDirectory, "schemas", schema);
}

import { resolve } from "node:path";

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

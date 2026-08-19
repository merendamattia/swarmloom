import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const releaseHeading = /^#{1,6}\s+\[?v?(\d+\.\d+\.\d+)\]?(?:\s|$|[(])/m;

export function parseReleaseVersion(changelog: string) {
  const match = changelog.match(releaseHeading);
  if (!match) throw new Error("No release version heading found in changelog");
  return match[1];
}

export async function readApplicationVersion() {
  const path = resolve(import.meta.dir, "../../../../CHANGELOG.md");
  return parseReleaseVersion(await readFile(path, "utf8"));
}
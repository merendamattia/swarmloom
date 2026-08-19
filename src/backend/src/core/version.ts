import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const semanticVersionHeading = /^#{1,2}\s+\[([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\](?=\(|\s|$)/m;

export function parseChangelogVersion(changelog: string) {
  const version = changelog.match(semanticVersionHeading)?.[1];
  if (!version) throw new Error("No semantic version found in CHANGELOG.md");
  return version;
}

export function readApplicationVersion() {
  return parseChangelogVersion(readFileSync(resolve(process.cwd(), "CHANGELOG.md"), "utf8"));
}

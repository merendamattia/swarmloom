import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubClient } from "../src/github/client.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXYQAAAAASUVORK5CYII=", "base64");
const image = "![Desktop](.agent-work/screenshots/desktop.png)";

describe("GitHub screenshot comments", () => {
  let root: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "swarmloom-screenshots-")));
    await mkdir(join(root, ".agent-work/screenshots"), { recursive: true });
    await mkdir(join(root, "bin"));
    await writeFile(join(root, ".agent-work/screenshots/desktop.png"), png);
    await writeFile(join(root, "bin/gh"), `#!/usr/bin/env python3
import json, os, sys
with open(${JSON.stringify(join(root, "invocation.json"))}, "w") as output:
    json.dump({"args": sys.argv[1:], "body": sys.stdin.read(), "cwd": os.getcwd(), "authenticated": os.environ.get("GH_TOKEN") == "secret-token"}, output)
if os.path.exists(${JSON.stringify(join(root, "fail"))}):
    sys.stderr.write("upload failed secret-token")
    sys.exit(1)
`);
    await chmod(join(root, "bin/gh"), 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${join(root, "bin")}:${originalPath}`;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  });

  test("uploads referenced screenshots once through gh, keeping the token out of arguments", async () => {
    const client = createGitHubClient({ token: "secret-token", fetch: async () => { throw new Error("Unexpected REST comment"); } });
    const body = `Review: pass\nTL;DR: Verified desktop.\n\n${image}\n${image}`;
    await client.addIssueComment("acme/app", 7, body, root);
    const call = JSON.parse(await readFile(join(root, "invocation.json"), "utf8"));
    expect(call).toEqual({
      args: ["issue", "comment", "7", "--repo", "github.com/acme/app", "--body-file", "-", "--attach", ".agent-work/screenshots/desktop.png"],
      body, cwd: root, authenticated: true,
    });
  });

  test("keeps ordinary comments on the REST path", async () => {
    let sent = "";
    const client = createGitHubClient({ token: "secret-token", fetch: async (_input, init) => {
      sent = String(init?.body);
      return Response.json({});
    } });
    await client.addIssueComment("acme/app", 7, `Verified.\n![Hosted](https://example.com/image.png)\n\n\`\`\`markdown\n${image}\n\`\`\``, root);
    expect(JSON.parse(sent).body).toContain("https://example.com/image.png");
    expect(await Bun.file(join(root, "invocation.json")).exists()).toBe(false);
  });

  test("rejects symlinks outside the screenshot directory and non-PNG bytes before upload", async () => {
    const client = createGitHubClient({ token: "secret-token" });
    await writeFile(join(root, "private.png"), png);
    await rm(join(root, ".agent-work/screenshots/desktop.png"));
    await symlink(join(root, "private.png"), join(root, ".agent-work/screenshots/desktop.png"));
    await expect(client.addIssueComment("acme/app", 7, image, root)).rejects.toThrow("outside the screenshot directory");
    await rm(join(root, ".agent-work/screenshots/desktop.png"));
    await writeFile(join(root, ".agent-work/screenshots/desktop.png"), "private text");
    await expect(client.addIssueComment("acme/app", 7, image, root)).rejects.toThrow("valid PNG");
    expect(await Bun.file(join(root, "invocation.json")).exists()).toBe(false);
  });

  test("redacts upload failures without posting a second comment", async () => {
    const client = createGitHubClient({ token: "secret-token", fetch: async () => { throw new Error("Unexpected REST comment"); } });
    await writeFile(join(root, "fail"), "");
    await expect(client.addIssueComment("acme/app", 7, image, root)).rejects.toThrow("upload failed [REDACTED]");
  });
});

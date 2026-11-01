import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubClient } from "../src/github/client.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNHsAAAAASUVORK5CYII=", "base64");

async function fixture() {
  const worktree = await mkdtemp(join(tmpdir(), "screenshot-test-"));
  directories.push(worktree);
  await mkdir(join(worktree, ".agent-work/screenshots"), { recursive: true });
  for (const name of ["desktop", "mobile"]) await writeFile(join(worktree, `.agent-work/screenshots/${name}.png`), png);
  return worktree;
}

function remote() {
  const comments: Array<{ id: number; html_url: string; body: string }> = [];
  return { comments, fetch: async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "GET") return Response.json(comments);
    const { body } = await request.json() as { body: string };
    if (request.method === "PATCH") {
      const comment = comments.find((comment) => request.url.endsWith(`/issues/comments/${comment.id}`));
      if (!comment) throw new Error("Repair must target the existing comment ID");
      comment.body = body;
      return Response.json(comment);
    }
    const comment = { id: 12, html_url: "https://github.com/acme/app/issues/7#issuecomment-12", body };
    comments.push(comment);
    return Response.json(comment);
  } };
}

const body = "Outcome: implemented\nTL;DR: Fixed.\n![Desktop](.agent-work/screenshots/desktop.png)\n![Mobile](.agent-work/screenshots/mobile.png)";

for (const caption of ["Desktop [dark]", "Desktop [dark [high contrast]]", String.raw`Desktop \] dark`, "Desktop $&", "Desktop $`", "Desktop $'"]) {
  for (const available of [true, false]) {
    test(`preserves literal caption ${JSON.stringify(caption)} with ${available ? "hosted" : "missing"} evidence`, async () => {
      const worktree = await fixture();
      if (!available) await rm(join(worktree, ".agent-work/screenshots/desktop.png"));
      const state = remote();
      let uploads = 0;
      const client = createGitHubClient({ token: "secret-token", fetch: state.fetch, uploadScreenshots: async (input) => {
        uploads += 1;
        expect(input.body).not.toContain(".agent-work/screenshots/");
        expect(input.files).toHaveLength(1);
        state.comments.push({ id: 12, html_url: "https://github.com/acme/app/issues/7#issuecomment-12", body: input.body + `\n![${input.files[0]!.alt}](https://github.com/user-attachments/assets/desktop)` });
        return { exitCode: 0, stderr: "" };
      } });
      const response = `Outcome: implemented\n![${caption}](.agent-work/screenshots/desktop.png)\nUseful evidence.`;
      const options = { worktreePath: worktree, publicationId: "literal-caption" };
      expect(await client.addIssueComment("acme/app", 7, response, options)).toMatchObject({
        publication: available ? "complete" : "text_only",
        missing: available ? [] : ["desktop.png"],
        problems: available ? [] : expect.arrayContaining(["desktop.png:missing_file", "incomplete_attachments"]),
      });
      const published = state.comments[0]!.body;
      expect(published).toStartWith(`Outcome: implemented\n${available ? `![${caption}](https://github.com/user-attachments/assets/desktop)` : "[Screenshot unavailable: desktop.png]"}\nUseful evidence.`);
      expect(published).not.toContain(".agent-work/screenshots/");
      await client.addIssueComment("acme/app", 7, response, options);
      expect(state.comments).toHaveLength(1);
      expect(state.comments[0]!.body).toBe(published);
      expect(uploads).toBe(available ? 1 : 0);
    });
  }
}

test("snapshots survive source removal and a partial CLI post is reconciled without duplicating comments", async () => {
  const worktree = await fixture();
  const state = remote();
  let uploads = 0;
  const client = createGitHubClient({ token: "secret-token", fetch: state.fetch, uploadScreenshots: async (input) => {
    uploads += 1;
    await rm(join(worktree, ".agent-work"), { recursive: true });
    expect(input.body).not.toContain(".agent-work/screenshots/");
    expect(await readFile(input.files[0]!.path)).toEqual(png);
    expect(await readFile(input.files[1]!.path)).toEqual(png);
    state.comments.push({ id: 12, html_url: "https://github.com/acme/app/issues/7#issuecomment-12", body: `${input.body}\n![${input.files[0]!.alt}](https://github.com/user-attachments/assets/desktop)` });
    return { exitCode: 1, stderr: "failed to upload: open /private/worktree/mobile.png: no such file or directory" };
  } });
  const options = { worktreePath: worktree, publicationId: "job-1" };
  const result = await client.addIssueComment("acme/app", 7, body, options);
  expect(result).toMatchObject({ publication: "partial", uploadExitCode: 1, commentUrl: state.comments[0]!.html_url, missing: ["mobile.png"] });
  expect(state.comments[0]!.body).toContain("![Desktop](https://github.com/user-attachments/assets/desktop)");
  expect(state.comments[0]!.body).not.toContain(".agent-work/screenshots/");
  expect(JSON.stringify(result)).not.toContain("/private/");
  await client.addIssueComment("acme/app", 7, body, options);
  expect(uploads).toBe(1);
  expect(state.comments).toHaveLength(1);
});

test("all images are hosted once, with duplicate references and identical captions preserved on retry", async () => {
  const worktree = await fixture();
  const state = remote();
  const response = body.replace("Mobile", "Desktop") + "\n![Again](./.agent-work/screenshots/desktop.png)";
  let uploads = 0;
  let staged = "";
  const client = createGitHubClient({ token: "secret-token", fetch: state.fetch, uploadScreenshots: async (input) => {
    uploads += 1;
    expect(input.files).toHaveLength(2);
    staged = input.files[0]!.path;
    state.comments.push({ id: 12, html_url: "https://github.com/acme/app/pull/8#issuecomment-12", body: input.body + input.files.map((file, index) => `\n![${file.alt}](https://github.com/user-attachments/assets/image-${index})`).join("") });
    return { exitCode: 0, stderr: "" };
  } });
  const options = { worktreePath: worktree, publicationId: "job-2" };
  expect(await client.addIssueComment("acme/app", 8, response, options)).toMatchObject({ publication: "complete", missing: [], problems: [] });
  expect(await Bun.file(staged).exists()).toBe(false);
  const published = state.comments[0]!.body;
  expect(published).toContain("![Desktop](https://github.com/user-attachments/assets/image-0)");
  expect(published).toContain("![Desktop](https://github.com/user-attachments/assets/image-1)");
  expect(published).toContain("![Again](https://github.com/user-attachments/assets/image-0)");
  await client.addIssueComment("acme/app", 8, response, options);
  expect(state.comments[0]!.body).toBe(published);
  expect(uploads).toBe(1);
});

test("missing, truncated, oversized, symlinked and traversing PNGs publish safe text evidence", async () => {
  const { symlink, truncate } = await import("node:fs/promises");
  const worktree = await fixture();
  await rm(join(worktree, ".agent-work/screenshots/mobile.png"));
  await writeFile(join(worktree, ".agent-work/screenshots/truncated.png"), png.subarray(0, 8));
  await writeFile(join(worktree, ".agent-work/screenshots/large.png"), png);
  await truncate(join(worktree, ".agent-work/screenshots/large.png"), 10 * 1024 * 1024 + 1);
  await symlink(join(worktree, ".agent-work/screenshots/desktop.png"), join(worktree, ".agent-work/screenshots/link.png"));
  const state = remote();
  const invalid = ["mobile.png", "truncated.png", "large.png", "link.png", "../desktop.png"].map((path) => `![Evidence](.agent-work/screenshots/${path})`).join("\n");
  const client = createGitHubClient({ token: "secret-token", fetch: state.fetch, uploadScreenshots: async () => { throw new Error("Must not upload invalid files"); } });
  const result = await client.addIssueComment("acme/app", 7, "Outcome: blocked\n" + invalid, { worktreePath: worktree, publicationId: "invalid" });
  expect(result).toMatchObject({ publication: "text_only", problems: expect.arrayContaining(["mobile.png:missing_file", "truncated.png:invalid_image", "large.png:invalid_image", "link.png:invalid_image", "invalid-reference-5:invalid_reference"]) });
  expect(state.comments[0]!.body).toContain("Outcome: blocked");
  expect(state.comments[0]!.body).not.toContain(".agent-work/screenshots/");
});

for (const failure of [
  { stderr: "HTTP 403: secret-token /private/worktree forbidden", timedOut: false, reason: "permission_denied" },
  { stderr: "secret-token /private/worktree", timedOut: true, reason: "timeout" },
  { stderr: "upload server unavailable /private/worktree", timedOut: false, reason: "upload_failed" },
]) {
  test(`reports ${failure.reason} separately from a missing comment without leaking CLI output`, async () => {
    const worktree = await fixture();
    const state = remote();
    const client = createGitHubClient({ token: "secret-token", fetch: state.fetch, uploadScreenshots: async () => ({ exitCode: 1, ...failure }) });
    const result = await client.addIssueComment("acme/app", 7, body, { worktreePath: worktree, publicationId: failure.reason });
    expect(result).toMatchObject({ publication: failure.timedOut ? "unknown" : "not_posted", problems: expect.arrayContaining([failure.reason, "comment_not_found"]) });
    expect(state.comments).toHaveLength(0);
    expect(JSON.stringify(result)).not.toMatch(/secret-token|\/private\/worktree/);
  });
}

test("a timeout after partial publication retains hosted evidence and repairs the specific comment", async () => {
  const worktree = await fixture();
  const state = remote();
  const client = createGitHubClient({ token: "secret-token", fetch: state.fetch, uploadScreenshots: async (input) => {
    state.comments.push({ id: 12, html_url: "https://github.com/acme/app/pull/8#issuecomment-12", body: input.body + `\n![${input.files[0]!.alt}](https://github.com/user-attachments/assets/desktop)\n![Mobile](.agent-work/screenshots/mobile.png)` });
    return { exitCode: 137, stderr: "", timedOut: true };
  } });
  const result = await client.addIssueComment("acme/app", 8, body, { worktreePath: worktree, publicationId: "timeout-partial" });
  expect(result).toMatchObject({ publication: "partial", problems: expect.arrayContaining(["timeout"]) });
  expect(state.comments[0]!.body).not.toContain(".agent-work/screenshots/");
  expect(state.comments[0]!.body).toContain("https://github.com/user-attachments/assets/desktop");
  expect(state.comments).toHaveLength(1);
});

test("unknown publication after a failed lookup never retries creation", async () => {
  const worktree = await fixture();
  let reads = 0;
  let uploads = 0;
  const client = createGitHubClient({ token: "secret-token", fetch: async () => {
    if (++reads > 1) return Response.json({ message: "unavailable" }, { status: 503 });
    return Response.json([]);
  }, uploadScreenshots: async () => { uploads += 1; return { exitCode: 1, stderr: "network error" }; } });
  const options = { worktreePath: worktree, publicationId: "unknown" };
  expect(await client.addIssueComment("acme/app", 7, body, options)).toMatchObject({ publication: "unknown", problems: expect.arrayContaining(["comment_lookup_failed:upload_failed"]) });
  expect(await client.addIssueComment("acme/app", 7, body, options)).toMatchObject({ publication: "unknown" });
  expect(uploads).toBe(1);
});

test("a failed repair reports the known comment without claiming the comment was never posted", async () => {
  const worktree = await fixture();
  const state = remote();
  const client = createGitHubClient({ token: "secret-token", fetch: async (input, init) => {
    if (init?.method === "PATCH") return Response.json({ message: "forbidden" }, { status: 403 });
    return state.fetch(input, init);
  }, uploadScreenshots: async (input) => {
    state.comments.push({ id: 12, html_url: "https://github.com/acme/app/issues/7#issuecomment-12", body: input.body + `\n![${input.files[0]!.alt}](https://github.com/user-attachments/assets/desktop)` });
    return { exitCode: 1, stderr: "failed" };
  } });
  const result = await client.addIssueComment("acme/app", 7, body, { worktreePath: worktree, publicationId: "repair" });
  expect(result).toMatchObject({ publication: "partial", commentUrl: state.comments[0]!.html_url, problems: expect.arrayContaining(["comment_repair_failed:permission_denied"]) });
  expect(state.comments[0]!.body).not.toContain(".agent-work/screenshots/");
});

test("limits upload to 50 distinct snapshots and never publishes the omitted local link", async () => {
  const worktree = await fixture();
  const state = remote();
  const paths = Array.from({ length: 51 }, (_, index) => `.agent-work/screenshots/image-${index}.png`);
  await Promise.all(paths.map((path) => writeFile(join(worktree, path), png)));
  const client = createGitHubClient({ token: "secret-token", fetch: state.fetch, uploadScreenshots: async (input) => {
    expect(input.files).toHaveLength(50);
    expect(input.body).not.toContain(".agent-work/screenshots/");
    state.comments.push({ id: 12, html_url: "https://github.com/acme/app/issues/7#issuecomment-12", body: input.body + input.files.map((file, index) => `\n![${file.alt}](https://github.com/user-attachments/assets/image-${index})`).join("") });
    return { exitCode: 0, stderr: "" };
  } });
  const result = await client.addIssueComment("acme/app", 7, paths.map((path) => `![Evidence](${path})`).join("\n"), { worktreePath: worktree, publicationId: "limit" });
  expect(result).toMatchObject({ publication: "partial", missing: ["image-50.png"], problems: expect.arrayContaining(["image-50.png:image_limit"]) });
  expect(state.comments[0]!.body).not.toContain(".agent-work/screenshots/");
});

test("a nonzero CLI result remains diagnosable even when all hosted images exist", async () => {
  const worktree = await fixture();
  const state = remote();
  const client = createGitHubClient({ token: "secret-token", fetch: state.fetch, uploadScreenshots: async (input) => {
    state.comments.push({ id: 12, html_url: "https://github.com/acme/app/issues/7#issuecomment-12", body: input.body + input.files.map((file, index) => `\n![${file.alt}](https://github.com/user-attachments/assets/image-${index})`).join("") });
    return { exitCode: 1, stderr: "upload response failed" };
  } });
  expect(await client.addIssueComment("acme/app", 7, body, { worktreePath: worktree, publicationId: "complete-with-error" }))
    .toMatchObject({ publication: "complete", missing: [], problems: ["upload_failed"] });
});

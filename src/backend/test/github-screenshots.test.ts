import { afterEach, expect, spyOn, test } from "bun:test";
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

function remote(origin = "https://github.com") {
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
    const number = /\/issues\/(\d+)\/comments$/.exec(new URL(request.url).pathname)![1];
    const comment = { id: 12, html_url: `${origin}/acme/app/issues/${number}#issuecomment-12`, body };
    comments.push(comment);
    return Response.json(comment);
  } };
}

const body = "Outcome: implemented\nTL;DR: Fixed.\n![Desktop](.agent-work/screenshots/desktop.png)\n![Mobile](.agent-work/screenshots/mobile.png)";

for (const caption of ["Desktop [dark]", "Desktop [dark [high contrast]]", String.raw`Desktop \] dark`, "Desktop $&", "Desktop $`", "Desktop $'", "The `]` key"]) {
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

for (const image of ["![Desktop][desktop]", "![Desktop][]", "![Desktop]", "![Desktop](<.agent-work/screenshots/desktop.png> \"Evidence\")"]) {
  for (const available of [true, false]) {
    test(`publishes ${image} with ${available ? "hosted" : "missing"} evidence and reuses the comment`, async () => {
      const worktree = await fixture();
      if (!available) await rm(join(worktree, ".agent-work/screenshots/desktop.png"));
      const state = remote();
      let uploads = 0;
      const client = createGitHubClient({ token: "secret-token", fetch: state.fetch, uploadScreenshots: async (input) => {
        uploads += 1;
        expect(input.body).not.toContain(".agent-work/screenshots/");
        expect(input.files).toHaveLength(1);
        state.comments.push({ id: 12, html_url: "https://github.com/acme/app/pull/8#issuecomment-12", body: input.body + `\n![${input.files[0]!.alt}](https://github.com/user-attachments/assets/desktop)` });
        return { exitCode: 0, stderr: "" };
      } });
      const response = `Outcome: implemented\n${image}\nUseful evidence.\n\n[desktop]: .agent-work/screenshots/desktop.png`;
      const options = { worktreePath: worktree, publicationId: "reference-image" };
      expect(await client.addIssueComment("acme/app", 8, response, options)).toMatchObject({
        publication: available ? "complete" : "text_only",
        missing: available ? [] : ["desktop.png"],
      });
      const published = state.comments[0]!.body;
      expect(published).toStartWith(`Outcome: implemented\n${available ? "![Desktop](https://github.com/user-attachments/assets/desktop)" : "[Screenshot unavailable: desktop.png]"}\nUseful evidence.`);
      expect(published).not.toContain(".agent-work/screenshots/");
      await client.addIssueComment("acme/app", 8, response, options);
      expect(state.comments).toHaveLength(1);
      expect(state.comments[0]!.body).toBe(published);
      expect(uploads).toBe(available ? 1 : 0);
    });
  }
}

test("replaces only image source ranges and leaves identical Markdown in code examples intact", async () => {
  const worktree = await fixture();
  await rm(join(worktree, ".agent-work/screenshots/desktop.png"));
  const state = remote();
  const client = createGitHubClient({ token: "secret-token", fetch: state.fetch });
  const image = "![Desktop](.agent-work/screenshots/desktop.png)";
  const example = `\`\`\`markdown\n${image}\n\`\`\``;
  const response = `Example:\n\n${example}\n\nEvidence:\n${image}`;
  expect(await client.addIssueComment("acme/app", 7, response, { worktreePath: worktree, publicationId: "source-ranges" })).toMatchObject({ publication: "text_only" });
  expect(state.comments[0]!.body).toStartWith(`Example:\n\n${example}\n\nEvidence:\n[Screenshot unavailable: desktop.png]`);
  const plain = remote();
  expect(await createGitHubClient({ token: "secret-token", fetch: plain.fetch }).addIssueComment("acme/app", 7, example)).toBeUndefined();
  expect(plain.comments[0]!.body).toBe(example);
});

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
  const response = body.replace("![Mobile](.agent-work/screenshots/mobile.png)", "![Mobile][mobile]") + "\n\n[mobile]: .agent-work/screenshots/mobile.png";
  const result = await client.addIssueComment("acme/app", 7, response, options);
  expect(result).toMatchObject({ publication: "partial", uploadExitCode: 1, commentUrl: state.comments[0]!.html_url, missing: ["mobile.png"] });
  expect(state.comments[0]!.body).toContain("![Desktop](https://github.com/user-attachments/assets/desktop)");
  expect(state.comments[0]!.body).not.toContain(".agent-work/screenshots/");
  expect(JSON.stringify(result)).not.toContain("/private/");
  await client.addIssueComment("acme/app", 7, response, options);
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

for (const [stage, stderr] of [
  ["permission preflight", "attaching files requires write access to the repository"],
  ["translated upload 404", "could not upload /private/worktree/desktop.png: attaching files requires write access to the repository"],
] as const) {
  test(`recognizes GitHub CLI's ${stage} denial without leaking stderr`, async () => {
    const worktree = await fixture();
    const state = remote();
    const client = createGitHubClient({ token: "secret-token", fetch: state.fetch, uploadScreenshots: async () => ({ exitCode: 1, stderr }) });
    const result = await client.addIssueComment("acme/app", 7, body, { worktreePath: worktree, publicationId: stage });
    expect(result).toMatchObject({ publication: "not_posted", problems: ["permission_denied", "comment_not_found"] });
    expect(state.comments).toHaveLength(0);
    expect(JSON.stringify(result)).not.toMatch(/write access|secret-token|\/private\/worktree/);
  });
}

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

for (const [number, origin] of [[7, "https://github.example.test"], [8, "https://github.example.test:8443"]] as const) {
  test(`Enterprise screenshot comment #${number} retains text on the configured host without invoking public GitHub`, async () => {
    const worktree = await fixture();
    const state = remote(origin);
    const requests: string[] = [];
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Attachments must not invoke CLI on unsupported hosts"); });
    try {
      const client = createGitHubClient({ token: "enterprise-secret", apiUrl: `${origin}/api/v3/`, fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.url);
        expect(request.headers.get("Authorization")).toBe("Bearer enterprise-secret");
        return state.fetch(input, init);
      } });
      const options = { worktreePath: worktree, publicationId: "enterprise-result" };
      const result = await client.addIssueComment("acme/app", number, body, options);
      expect(spawn).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        publication: "text_only", targetUrl: `${origin}/acme/app/issues/${number}`,
        commentUrl: state.comments[0]!.html_url, missing: ["desktop.png", "mobile.png"],
        problems: expect.arrayContaining(["attachments_unsupported_host", "incomplete_attachments"]),
      });
      expect(requests.every((url) => url.startsWith(`${origin}/api/v3/repos/acme/app/`))).toBe(true);
      expect(state.comments[0]!.body).toContain("Outcome: implemented\nTL;DR: Fixed.");
      expect(state.comments[0]!.body).toContain("[Screenshot unavailable: desktop.png]");
      expect(state.comments[0]!.body).not.toContain(".agent-work/screenshots/");
      const published = state.comments[0]!.body;
      expect(await client.addIssueComment("acme/app", number, body, options)).toMatchObject({ publication: "text_only", problems: expect.arrayContaining(["attachments_unsupported_host"]) });
      expect(state.comments).toHaveLength(1);
      expect(state.comments[0]!.body).toBe(published);
      expect(JSON.stringify(result)).not.toContain("enterprise-secret");
    } finally { spawn.mockRestore(); }
  });
}

for (const host of ["github.com", "acme.ghe.com"]) {
  test(`default uploader and reconciliation stay on ${host}, including retries`, async () => {
    const worktree = await fixture();
    const state = remote(`https://${host}`);
    const spawn = spyOn(Bun, "spawn").mockImplementation(((args: string[], options?: Parameters<typeof Bun.spawn>[1]) => {
      expect(options?.env?.GH_HOST).toBe(host);
      expect(options?.env?.GH_TOKEN).toBe("configured-token");
      expect(args[args.indexOf("--repo") + 1]).toBe(`${host}/acme/app`);
      const safeBody = new TextDecoder().decode(options?.stdin as Uint8Array);
      expect(safeBody).not.toContain(".agent-work/screenshots/");
      const attachments = args.filter((_, index) => args[index - 1] === "--attach");
      expect(attachments).toHaveLength(2);
      state.comments.push({ id: 12, html_url: `https://${host}/acme/app/issues/7#issuecomment-12`, body: safeBody + attachments.map((attachment, index) => `\n![${attachment.split("#")[1]}](https://${host}/user-attachments/assets/image-${index})`).join("") });
      return { exited: Promise.resolve(0), stderr: new Blob([]).stream(), kill: () => {} } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn);
    try {
      const client = createGitHubClient({ token: "configured-token", apiUrl: `https://api.${host}`, fetch: async (input, init) => {
        expect(new URL(String(input)).origin).toBe(`https://api.${host}`);
        return state.fetch(input, init);
      } });
      const options = { worktreePath: worktree, publicationId: "configured-host" };
      expect(await client.addIssueComment("acme/app", 7, body, options)).toMatchObject({ publication: "complete", targetUrl: `https://${host}/acme/app/issues/7`, missing: [], problems: [] });
      expect(state.comments[0]!.body).toContain(`![Desktop](https://${host}/user-attachments/assets/image-0)`);
      expect(state.comments[0]!.body).not.toContain(".agent-work/screenshots/");
      const published = state.comments[0]!.body;
      expect(await client.addIssueComment("acme/app", 7, body, options)).toMatchObject({ publication: "complete", missing: [], problems: [] });
      expect(state.comments).toHaveLength(1);
      expect(state.comments[0]!.body).toBe(published);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { spawn.mockRestore(); }
  });
}

test("cloud reconciliation rejects attachment URLs and saved identities from a different host", async () => {
  const worktree = await fixture();
  const origin = "https://acme.ghe.com";
  const state = remote(origin);
  let uploads = 0;
  const client = createGitHubClient({ token: "cloud-secret", apiUrl: "https://api.acme.ghe.com", fetch: state.fetch, uploadScreenshots: async (input) => {
    uploads += 1;
    state.comments.push({ id: 12, html_url: `${origin}/acme/app/issues/7#issuecomment-12`, body: input.body
      + `\n![${input.files[0]!.alt}](${origin}/user-attachments/assets/desktop)`
      + `\n![${input.files[1]!.alt}](https://github.com/user-attachments/assets/mobile)`
      + "\n<!-- swarmloom-attachment:1 https://github.com/user-attachments/assets/mobile -->" });
    return { exitCode: 0, stderr: "" };
  } });
  const options = { worktreePath: worktree, publicationId: "hosted-boundary" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    expect(await client.addIssueComment("acme/app", 7, body, options)).toMatchObject({ publication: "partial", missing: ["mobile.png"] });
    expect(state.comments[0]!.body).toContain(`![Desktop](${origin}/user-attachments/assets/desktop)`);
    expect(state.comments[0]!.body).toContain("[Screenshot unavailable: mobile.png]");
    expect(state.comments[0]!.body).not.toContain("https://github.com/");
  }
  expect(uploads).toBe(1);
  expect(state.comments).toHaveLength(1);
});

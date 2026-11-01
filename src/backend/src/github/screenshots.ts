import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { z } from "zod";

const maxSize = 10 * 1024 * 1024;
const localPath = /^(?:\.\/)?\.agent-work\/screenshots\/([a-zA-Z0-9_-]+\.png)$/;
const commentSchema = z.object({ id: z.number().int().positive(), html_url: z.url(), body: z.string().nullable() });
type Comment = z.infer<typeof commentSchema>;
type Request = (path: string, init?: RequestInit) => Promise<unknown>;
export type ScreenshotOptions = { worktreePath?: string; publicationId: string };
export type ScreenshotUpload = (input: { repository: string; number: number; body: string; files: Array<{ path: string; alt: string }> }) => Promise<{ exitCode: number; stderr: string; timedOut?: boolean }>;
export type ScreenshotPublication = {
  publication: "complete" | "partial" | "text_only" | "not_posted" | "unknown";
  targetUrl: string;
  commentUrl?: string;
  uploadExitCode?: number;
  missing: string[];
  problems: string[];
};

type MarkdownNode = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>["children"][number];
type ImageReference = { start: number; end: number; caption: string; path: string; definition: boolean };

function* nodes(node: MarkdownNode): Generator<MarkdownNode> {
  yield node;
  if ("children" in node) for (const child of node.children) yield* nodes(child);
}

function images(body: string) {
  const captions = new Map<number, string>();
  const tree = fromMarkdown(body, { mdastExtensions: [{ enter: {
    // AST alt text loses Markdown formatting and escapes; retain the source label.
    labelText(token) { captions.set(token.start.offset - 2, this.sliceSerialize(token)); },
  } }] });
  const entries = [...nodes(tree)];
  const definitions = entries.filter((node) => node.type === "definition");
  const references: ImageReference[] = [];
  for (const node of entries) {
    if (node.type !== "image" && node.type !== "imageReference") continue;
    const path = node.type === "image" ? node.url : definitions.find((definition) => definition.identifier === node.identifier)?.url;
    if (path === undefined) continue;
    const start = node.position!.start.offset!;
    references.push({ start, end: node.position!.end.offset!, caption: captions.get(start) ?? "", path, definition: false });
  }
  return { references, definitions };
}

function references(body: string): ImageReference[] {
  const parsed = images(body);
  const refs = parsed.references.filter((image) => !image.path.startsWith("https://") && image.path.includes(".agent-work/screenshots/"));
  // Rewrite shared definitions too, so reference links cannot retain local paths.
  return [...refs, ...parsed.definitions.filter((definition) => refs.some((ref) => ref.path === definition.url)).map((definition) => ({
    start: definition.position!.start.offset!, end: definition.position!.end.offset!,
    caption: definition.label ?? definition.identifier, path: definition.url, definition: true,
  }))].sort((a, b) => a.start - b.start);
}

function replaceReferences(body: string, refs: ImageReference[], replacement: (ref: ImageReference) => string) {
  return refs.reduceRight((text, ref) => text.slice(0, ref.start) + replacement(ref) + text.slice(ref.end), body);
}

export function hasScreenshotReferences(body: string) {
  return references(body).length > 0;
}

function failureCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/EACCES|EPERM|401|403|forbidden|permission|authentication|unsupported.*token/i.test(message)) return "permission_denied";
  if (/ENOENT|no such file/i.test(message)) return "missing_file";
  if (/timeout|timed out/i.test(message)) return "timeout";
  return "upload_failed";
}

async function snapshot(worktree: string | undefined, path: string, destination: string) {
  if (!worktree) throw new Error("ENOENT");
  const root = await realpath(worktree);
  const source = resolve(root, path);
  if (await realpath(source) !== source) throw new Error("invalid_image");
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxSize || stat.size < 45) throw new Error("invalid_image");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== stat.size || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("invalid_image");
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR"
      || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)
      || !bytes.subarray(size - 12, size).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) throw new Error("invalid_image");
    await writeFile(destination, bytes.subarray(0, size), { mode: 0o400, flag: "wx" });
  } finally {
    await file.close();
  }
}

export async function publishScreenshotComment(
  request: Request,
  upload: ScreenshotUpload | undefined,
  repository: string,
  number: number,
  body: string,
  options: ScreenshotOptions,
  githubUrl: URL,
): Promise<ScreenshotPublication> {
  const refs = references(body);
  const normalizedPath = (path: string) => path.replace(/^\.\//, "");
  const paths = [...new Set(refs.map((ref) => normalizedPath(ref.path)))];
  const names = paths.map((path, index) => localPath.exec(path)?.[1] ?? `invalid-reference-${index + 1}`);
  const hash = createHash("sha256").update(`${options.publicationId}\0${body}`).digest("hex");
  const marker = `<!-- swarmloom-evidence:${hash} -->`;
  const targetUrl = `${githubUrl.origin}/${repository}/issues/${number}`;
  const hostedPrefix = `${githubUrl.origin}/user-attachments/assets/`;
  const isHosted = (path: string) => path.startsWith(hostedPrefix) && /^[a-zA-Z0-9-]+$/.test(path.slice(hostedPrefix.length));
  const result: ScreenshotPublication = { publication: "not_posted", targetUrl, missing: [...names], problems: [] };
  if (!upload) result.problems.push("attachments_unsupported_host");
  const endpoint = `/repos/${repository}/issues/${number}/comments`;
  async function findComment() {
    for (let page = 1; ; page += 1) {
      const batch = z.array(commentSchema).parse(await request(`${endpoint}?per_page=100&page=${page}`));
      const comment = batch.find((item) => item.body?.includes(marker));
      if (comment || batch.length < 100) return comment;
    }
  }

  let comment: Comment | undefined;
  try { comment = await findComment(); } catch (error) {
    result.publication = "unknown";
    result.problems.push(`comment_lookup_failed:${failureCode(error)}`);
    return result;
  }

  // The CLI appends uploads to a body with no local image Markdown. Even a
  // partial post (or a crash before reconciliation) is therefore safe to read.
  const safeBody = replaceReferences(body, refs, () => "") + `\n\n${marker}`;
  let staging: string | undefined;
  try {
    if (!comment) {
      const files: Array<{ path: string; alt: string }> = [];
      if (upload) {
        try {
          staging = await mkdtemp(join(tmpdir(), "swarmloom-evidence-"));
          await chmod(staging, 0o700);
        } catch (error) {
          result.problems.push(`staging_failed:${failureCode(error)}`);
          return result;
        }
        for (const [index, path] of paths.entries()) {
          if (!localPath.test(path) || index >= 50) {
            result.problems.push(`${names[index]}:${index >= 50 ? "image_limit" : "invalid_reference"}`);
            continue;
          }
          const destination = join(staging, `${index}.png`);
          try {
            await snapshot(options.worktreePath, path, destination);
            files.push({ path: destination, alt: `swarmloom-${hash}-${index}` });
          } catch (error) {
            const reason = error instanceof Error && error.message === "invalid_image" ? "invalid_image" : failureCode(error);
            result.problems.push(`${names[index]}:${reason}`);
          }
        }
      }
      try {
        if (upload && files.length) {
          const uploaded = await upload({ repository, number, body: safeBody, files });
          result.uploadExitCode = uploaded.exitCode;
          if (uploaded.exitCode !== 0 || uploaded.timedOut) {
            result.problems.push(uploaded.timedOut ? "timeout" : failureCode(uploaded.stderr));
          }
        } else {
          await request(endpoint, { method: "POST", body: JSON.stringify({ body: safeBody }) });
        }
      } catch (error) {
        result.problems.push(failureCode(error));
      }
      // Never infer publication state from the CLI exit code. Its failed command
      // may already have posted a comment, or the REST response may have been lost.
      try { comment = await findComment(); } catch (error) {
        result.publication = "unknown";
        result.problems.push(`comment_lookup_failed:${failureCode(error)}`);
        return result;
      }
    }
    if (!comment) {
      if (result.problems.includes("timeout")) result.publication = "unknown";
      result.problems.push("comment_not_found");
      return result;
    }
    result.commentUrl = comment.html_url;
    const remoteBody = comment.body ?? "";
    const hosted = new Map<number, string>();
    for (const image of images(remoteBody).references) {
      const index = paths.findIndex((_, index) => image.caption === `swarmloom-${hash}-${index}`);
      if (index >= 0 && isHosted(image.path)) hosted.set(index, image.path);
    }
    // Persist image identities separately from captions: two screenshots can
    // legitimately have the same caption, including across repeated calls.
    for (const entry of remoteBody.matchAll(/<!-- swarmloom-attachment:(\d+) (\S+) -->/g)) {
      const index = Number(entry[1]);
      if (index < paths.length && isHosted(entry[2]!)) hosted.set(index, entry[2]!);
    }
    result.missing = names.filter((_, index) => !hosted.has(index));
    result.publication = !result.missing.length ? "complete" : hosted.size ? "partial" : "text_only";
    if (result.missing.length) result.problems.push("incomplete_attachments");
    const repaired = replaceReferences(body, refs, (ref) => {
      const index = paths.indexOf(normalizedPath(ref.path));
      const url = hosted.get(index);
      if (ref.definition) return url ? `[${ref.caption}]: ${url}` : "";
      return url ? `![${ref.caption}](${url})` : `[Screenshot unavailable: ${names[index]}]`;
    }) + `\n\n${marker}` + [...hosted].map(([index, url]) => `\n<!-- swarmloom-attachment:${index} ${url} -->`).join("");
    if (repaired !== remoteBody) {
      try {
        const updated = commentSchema.parse(await request(`/repos/${repository}/issues/comments/${comment.id}`, {
          method: "PATCH", body: JSON.stringify({ body: repaired }),
        }));
        if (updated.body !== repaired) throw new Error("comment body mismatch");
      } catch (error) {
        result.problems.push(`comment_repair_failed:${failureCode(error)}`);
      }
    }
    return result;
  } finally {
    if (staging) {
      try { await rm(staging, { recursive: true, force: true }); } catch (error) {
        result.problems.push(`staging_cleanup_failed:${failureCode(error)}`);
      }
    }
  }
}

export function createScreenshotUploader(token: string, githubUrl: URL): ScreenshotUpload | undefined {
  // GitHub CLI's attachment endpoint supports public GitHub and data-residency
  // cloud tenants, but not Enterprise Server or custom REST proxies.
  if (githubUrl.protocol !== "https:" || githubUrl.port || githubUrl.pathname !== "/"
    || !(githubUrl.hostname === "github.com" || /^[a-z0-9-]+\.ghe\.com$/.test(githubUrl.hostname))) return undefined;
  return async ({ repository, number, body, files }) => {
    const process = Bun.spawn(["gh", "issue", "comment", String(number), "--repo", `${githubUrl.host}/${repository}`, "--body-file", "-", ...files.flatMap((file) => ["--attach", `${file.path}#${file.alt}`])], {
      env: { ...globalThis.process.env, GH_TOKEN: token, GITHUB_TOKEN: token, GH_HOST: githubUrl.host, GH_PROMPT_DISABLED: "1" },
      stdin: new TextEncoder().encode(body), stdout: "ignore", stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; process.kill("SIGKILL"); }, 120_000);
    try {
      const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
      return { exitCode, stderr, timedOut };
    } finally { clearTimeout(timer); }
  };
}

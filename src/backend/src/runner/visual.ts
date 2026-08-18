import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";
import { redactSecrets } from "../core/secrets.ts";

export const VISUAL_VIEWPORT = { width: 1_280, height: 800 } as const;

export type VisualEvidence = {
  route: string;
  setupNote?: string;
};

export type VisualOutcome = {
  status: "attached" | "incomplete";
  route: string;
  imageUrl?: string;
  reason?: string;
};

export type CaptureVisualEvidenceInput = {
  dataDir: string;
  publicBaseUrl: string;
  jobId: string;
  worktreePath: string;
  visual: VisualEvidence;
  port: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type CaptureVisualEvidence = (input: CaptureVisualEvidenceInput) =>
  Promise<{ fileName: string; imageUrl: string } | { error: string }>;

export function artifactDirectory(dataDir: string, jobId: string) {
  const root = resolve(dataDir, "artifacts");
  const directory = resolve(root, jobId);
  if (!directory.startsWith(`${root}${sep}`)) throw new Error("Artifact path escapes data directory");
  return directory;
}

export function artifactFileName() {
  return `${randomBytes(16).toString("hex")}.png`;
}

export function artifactPublicUrl(publicBaseUrl: string, jobId: string, fileName: string) {
  const url = new URL(publicBaseUrl);
  url.pathname = `/api/artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(fileName)}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function visualEvidenceComment(route: string, imageUrl: string) {
  return [
    "## Visual evidence",
    "",
    `Screenshot of the implemented view at \`${route}\` captured by the worker:`,
    "",
    `![Implemented view at ${route}](${imageUrl})`,
    "",
    `[Open screenshot directly](${imageUrl})`,
  ].join("\n");
}

export async function captureScreenshot(input: CaptureVisualEvidenceInput): Promise<
  { fileName: string; imageUrl: string } | { error: string }
> {
  const { dataDir, publicBaseUrl, jobId, worktreePath, visual, port, timeoutMs, signal } = input;
  const directory = artifactDirectory(dataDir, jobId);
  await mkdir(directory, { recursive: true });
  const logPath = resolve(directory, "frontend.log");
  const pageUrl = `http://127.0.0.1:${port}${normalizeRoute(visual.route)}`;

  const frontend = visual.setupNote
    ? startFrontend(visual.setupNote, worktreePath, logPath)
    : undefined;
  try {
    await waitForRoute(pageUrl, timeoutMs, signal);
    const fileName = artifactFileName();
    const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    try {
      const page = await browser.newPage({ viewport: { width: VISUAL_VIEWPORT.width, height: VISUAL_VIEWPORT.height } });
      await page.goto(pageUrl, { waitUntil: "load", timeout: timeoutMs });
      await page.waitForTimeout(500);
      await page.screenshot({ path: resolve(directory, fileName) });
    } finally {
      await browser.close();
    }
    return { fileName, imageUrl: artifactPublicUrl(publicBaseUrl, jobId, fileName) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const log = await readLogTail(logPath);
    return { error: truncate(`${detail}${log ? `\nFrontend log:\n${log}` : ""}`) };
  } finally {
    frontend?.kill();
  }
}

function normalizeRoute(route: string) {
  return route.startsWith("/") ? route : `/${route}`;
}

function startFrontend(setupNote: string, worktreePath: string, logPath: string) {
  const logFd = openSync(logPath, "w");
  const process = Bun.spawn(["/bin/sh", "-c", setupNote], {
    cwd: worktreePath,
    stdout: logFd,
    stderr: logFd,
    detached: true,
  });
  closeSync(logFd);
  return {
    kill: () => {
      killProcessGroup(process.pid as number);
    },
  };
}

function killProcessGroup(pgid: number) {
  try {
    Bun.spawnSync(["kill", "--", `-${pgid}`]);
  } catch {
    // fall through: if the group is gone there is nothing to stop
  }
}

async function readLogTail(logPath: string) {
  const file = Bun.file(logPath);
  if (!await file.exists()) return "";
  return redactSecrets((await file.text()).slice(-2_000));
}

async function waitForRoute(url: string, timeoutMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    try {
      const response = await fetch(url, { signal });
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(`Frontend did not become ready at ${url} within ${timeoutMs}ms${lastError ? `: ${lastError}` : ""}`);
}

function truncate(text: string) {
  return text.slice(0, 2_000);
}

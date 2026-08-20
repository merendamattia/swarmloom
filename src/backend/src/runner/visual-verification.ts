import { chromium } from "playwright";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { redactSecrets } from "../core/secrets.ts";
import type { Config } from "../core/config-schema.ts";
import { createVisualArtifactUrl, visualArtifactPath, visualArtifactTempPath } from "../artifacts.ts";

const viewport = { width: 1440, height: 900 };
const startupAttempts = 40;
const startupDelayMs = 250;
const navigationTimeoutMs = 1_500;

export type VisualVerificationInput = {
  jobId: string;
  worktreePath: string;
  route: string;
  origin: string;
  setup: string | null;
  signal: AbortSignal;
};

export type VisualVerificationResult =
  | {
      status: "COMPLETED";
      route: string;
      artifactUrl: string;
      capturedAt: string;
      viewport: typeof viewport;
    }
  | {
      status: "INCOMPLETE";
      route: string | null;
      reason: string;
      capturedAt: string;
    };

export type VisualVerification = {
  verify(input: VisualVerificationInput): Promise<VisualVerificationResult>;
};

export function createVisualVerification(
  config: Pick<Config, "DATA_DIR" | "ARTIFACT_BASE_URL" | "SETTINGS_ENCRYPTION_KEY">,
): VisualVerification {
  return {
    async verify(input) {
      const capturedAt = new Date().toISOString();
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      let frontend: Bun.Subprocess | undefined;
      const finalPath = visualArtifactPath(config.DATA_DIR, input.jobId);
      const temporaryPath = visualArtifactTempPath(config.DATA_DIR, input.jobId);
      try {
        const targetUrl = visualRouteUrl(input.origin, input.route);
        await mkdir(dirname(finalPath), { recursive: true });
        if (input.setup && input.setup.toLowerCase() !== "none") {
          frontend = Bun.spawn(["sh", "-lc", input.setup], {
            cwd: input.worktreePath,
            stdout: "ignore",
            stderr: "ignore",
          });
        }
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport });
        await waitForPage(page, targetUrl.href, input.signal);
        await page.screenshot({ path: temporaryPath, animations: "disabled" });
        await rename(temporaryPath, finalPath);
        return {
          status: "COMPLETED",
          route: routeForComment(targetUrl),
          artifactUrl: createVisualArtifactUrl(
            config.ARTIFACT_BASE_URL,
            config.SETTINGS_ENCRYPTION_KEY,
            input.jobId,
          ),
          capturedAt,
          viewport,
        };
      } catch (error) {
        await rm(temporaryPath, { force: true });
        return {
          status: "INCOMPLETE",
          route: safeRoute(input.route),
          reason: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000),
          capturedAt,
        };
      } finally {
        await browser?.close().catch(() => {});
        frontend?.kill();
      }
    },
  };
}

export async function waitForPage(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>,
  url: string,
  signal: AbortSignal,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
    }
  }
  throw lastError ?? new Error(`Frontend route did not become ready: ${url}`);
}

export function visualRouteUrl(baseUrl: string, route: string) {
  if (!route.startsWith("/") || route.startsWith("//")) throw new Error("Visual route must be an absolute application path");
  const base = new URL(baseUrl);
  const target = new URL(route, base);
  if (target.origin !== base.origin) throw new Error("Visual route must stay on the configured frontend origin");
  return target;
}

function routeForComment(url: URL) {
  return `${url.pathname}${url.search}${url.hash}`;
}

function safeRoute(route: string) {
  return route.startsWith("/") && !route.startsWith("//") ? route.slice(0, 500) : null;
}

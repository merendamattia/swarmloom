import { createHmac, timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";

const artifactDirectory = "visual-artifacts";
const tokenLifetimeMs = 30 * 24 * 60 * 60 * 1_000;

export function visualArtifactPath(dataDirectory: string, jobId: string) {
  const root = resolve(dataDirectory, artifactDirectory);
  const path = resolve(root, `${jobId}.png`);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("Artifact path escapes data directory");
  return path;
}

export function visualArtifactTempPath(dataDirectory: string, jobId: string) {
  return `${visualArtifactPath(dataDirectory, jobId)}.tmp-${crypto.randomUUID()}`;
}

export function createVisualArtifactUrl(
  baseUrl: string,
  secret: string,
  jobId: string,
  now = Date.now(),
) {
  const expiresAt = now + tokenLifetimeMs;
  const token = createArtifactToken(secret, jobId, expiresAt);
  return `${baseUrl.replace(/\/$/, "")}/api/artifacts/${encodeURIComponent(jobId)}?token=${encodeURIComponent(token)}`;
}

export function verifyArtifactToken(secret: string, jobId: string, token: string, now = Date.now()) {
  const [expiryText, signature] = token.split(".");
  const expiresAt = Number(expiryText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now || !signature) return false;
  const expected = sign(secret, `${jobId}.${expiresAt}`);
  const providedBytes = Buffer.from(signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

function createArtifactToken(secret: string, jobId: string, expiresAt: number) {
  return `${expiresAt}.${sign(secret, `${jobId}.${expiresAt}`)}`;
}

function sign(secret: string, value: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

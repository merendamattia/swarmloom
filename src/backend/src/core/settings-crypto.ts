import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const version = "v1";

function key(value: string) {
  return createHash("sha256").update(value).digest();
}

export function encryptSetting(value: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [version, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptSetting(value: string, secret: string) {
  const [storedVersion, iv, tag, encrypted] = value.split(":");
  if (storedVersion !== version || !iv || !tag || !encrypted) throw new Error("Invalid encrypted setting");
  const decipher = createDecipheriv(algorithm, key(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

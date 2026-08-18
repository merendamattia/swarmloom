import { redactSecrets } from "./secrets.ts";

type Fields = Record<string, unknown>;

function write(level: "info" | "warn" | "error", message: string, fields: Fields = {}) {
  const line = redactSecrets(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...fields }));
  (level === "error" ? console.error : level === "warn" ? console.warn : console.info)(line);
}

export const logger = {
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
};

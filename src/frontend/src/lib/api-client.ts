import { hc } from "hono/client";
import type { AppType } from "swarmloom-backend/api";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:18421";
export const api = hc<AppType>(API_URL).api;

export async function json<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

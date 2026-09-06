import { describe, expect, test } from "bun:test";
import { statusRefetchInterval } from "./api";

describe("status polling", () => {
  test("refreshes authenticated provider usage at the reader freshness interval", () => {
    expect(statusRefetchInterval("authenticated")).toBe(30_000);
    expect(statusRefetchInterval("required")).toBe(5_000);
    expect(statusRefetchInterval(undefined)).toBe(false);
  });
});

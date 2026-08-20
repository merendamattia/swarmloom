import { describe, expect, test } from "bun:test";
import {
  describeCron,
  parseRepositoryList,
  removeRepository,
  secondsToMilliseconds,
} from "./settings";

describe("settings presentation helpers", () => {
  test("normalizes the stored repository list into unique tags", () => {
    expect(parseRepositoryList("acme/api, acme/web\nacme/api")).toEqual([
      "acme/api",
      "acme/web",
    ]);
  });

  test("keeps one repository because the settings API requires a repository", () => {
    expect(removeRepository(["acme/api"], "acme/api")).toEqual(["acme/api"]);
  });

  test("explains a recurring minute schedule", () => {
    expect(describeCron("*/30 * * * *")).toBe("Every 30 minutes");
  });

  test("converts seconds back to the runtime milliseconds format", () => {
    expect(secondsToMilliseconds(60)).toBe(60_000);
  });
});

import { describe, expect, test } from "bun:test";
import loadConfig from "next/dist/server/config";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

const config = await loadConfig(PHASE_PRODUCTION_BUILD, import.meta.dir);

describe("next.config.ts", () => {
  test("caps the build worker count at exactly five CPUs", () => {
    expect(config.experimental?.cpus).toBe(5);
  });
});

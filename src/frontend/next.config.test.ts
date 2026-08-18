import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const configPath = resolve(import.meta.dir, "next.config.ts");

describe("next.config.ts", () => {
  test("caps the build worker count at exactly five CPUs", async () => {
    const config = await Bun.file(configPath).text();
    expect(config).toContain("cpus: 5");
  });
});

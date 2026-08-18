import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const frontendRoot = resolve(import.meta.dir, "../..");
const appRoot = resolve(import.meta.dir, "../app");

describe("brand assets", () => {
  test("ships the responsive logo and install icons", async () => {
    await expect(Bun.file(resolve(frontendRoot, "public/brand/logo.png")).exists()).resolves.toBe(true);
    await expect(Bun.file(resolve(frontendRoot, "public/brand/logo-no-name.png")).exists()).resolves.toBe(true);
    await expect(Bun.file(resolve(appRoot, "icon.png")).exists()).resolves.toBe(true);
    await expect(Bun.file(resolve(appRoot, "apple-icon.png")).exists()).resolves.toBe(true);
    await expect(Bun.file(resolve(appRoot, "manifest.ts")).exists()).resolves.toBe(true);
  });

  test("uses the logo in the README and application header", async () => {
    const [readme, shell] = await Promise.all([
      Bun.file(resolve(frontendRoot, "../../README.md")).text(),
      Bun.file(resolve(frontendRoot, "src/components/app-shell.tsx")).text(),
    ]);
    expect(readme).toContain("src/frontend/public/brand/logo.png");
    expect(shell).toContain('src="/brand/logo.png"');
  });
});

import { expect, test } from "bun:test";
import { providerLoginCommand } from "../src/core/provider-auth.ts";

test("returns the login command for the configured provider", () => {
  expect(providerLoginCommand("codex")).toBe("codex login --device-auth");
  expect(providerLoginCommand("opencode")).toBe("opencode auth login");
});

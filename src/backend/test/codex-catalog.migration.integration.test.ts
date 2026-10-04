import { afterAll, describe, expect, test } from "bun:test";

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("Codex catalog migration", () => {
  let prisma: typeof import("../src/core/db.ts").prisma;

  afterAll(async () => { await prisma?.$disconnect(); });

  test("replaces removed selections and keeps valid Luna and Astra settings", async () => {
    ({ prisma } = await import("../src/core/db.ts"));
    const migration = await Bun.file(new URL("../prisma/migrations/0018_gpt_6_1_sol_catalog/migration.sql", import.meta.url)).text();
    const rollback = new Error("rollback migration fixture");

    try {
      await prisma.$transaction(async (tx) => {
        await tx.codexModel.delete({ where: { slug: "gpt-6.1-sol" } });
        await tx.codexModel.updateMany({ data: { enabled: true } });
        const legacyEnvironments = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-sol"]
          .map((model) => ({ model, environment: `codex-migration-${crypto.randomUUID()}` }));
        await tx.runtimeSetting.createMany({ data: [
          ...legacyEnvironments.flatMap(({ model, environment }) => [
            { environment, key: "CODEX_CODING_MODEL", value: model },
            { environment, key: "CODEX_CODING_REASONING_EFFORT", value: "max" },
          ]),
          { environment: legacyEnvironments[0].environment, key: "CODEX_REVIEW_MODEL", value: "gpt-6-sol" },
          { environment: legacyEnvironments[0].environment, key: "CODEX_REVIEW_REASONING_EFFORT", value: "high" },
        ] });
        const validEnvironment = `codex-valid-${crypto.randomUUID()}`;
        await tx.runtimeSetting.createMany({ data: [
          { environment: validEnvironment, key: "CODEX_CODING_MODEL", value: "gpt-6-luna" },
          { environment: validEnvironment, key: "CODEX_CODING_REASONING_EFFORT", value: "low" },
          { environment: validEnvironment, key: "CODEX_REVIEW_MODEL", value: "gpt-6-astra" },
          { environment: validEnvironment, key: "CODEX_REVIEW_REASONING_EFFORT", value: "high" },
        ] });

        for (const statement of migration.split(";").map((part) => part.trim()).filter(Boolean)) {
          await tx.$executeRawUnsafe(statement);
        }

        expect((await tx.codexModel.findMany({ where: { enabled: true }, orderBy: { sortOrder: "asc" } }))
          .map(({ slug }) => slug)).toEqual(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]);
        const sol = await tx.codexModel.findUniqueOrThrow({
          where: { slug: "gpt-6.1-sol" },
          include: { efforts: { include: { reasoningEffort: true } } },
        });
        expect(sol.defaultReasoningEffort).toBe("medium");
        expect(sol.efforts.find(({ reasoningEffort }) => reasoningEffort.slug === "medium")?.isDefault).toBe(true);
        for (const { environment } of legacyEnvironments) {
          expect(Object.fromEntries((await tx.runtimeSetting.findMany({ where: { environment } }))
            .map(({ key, value }) => [key, value]))).toMatchObject({
            CODEX_CODING_MODEL: "gpt-6.1-sol",
            CODEX_CODING_REASONING_EFFORT: "medium",
          });
        }
        expect(Object.fromEntries((await tx.runtimeSetting.findMany({
          where: { environment: legacyEnvironments[0].environment },
        })).map(({ key, value }) => [key, value]))).toMatchObject({
          CODEX_REVIEW_MODEL: "gpt-6.1-sol",
          CODEX_REVIEW_REASONING_EFFORT: "medium",
        });
        expect(Object.fromEntries((await tx.runtimeSetting.findMany({ where: { environment: validEnvironment } }))
          .map(({ key, value }) => [key, value]))).toEqual({
          CODEX_CODING_MODEL: "gpt-6-luna",
          CODEX_CODING_REASONING_EFFORT: "low",
          CODEX_REVIEW_MODEL: "gpt-6-astra",
          CODEX_REVIEW_REASONING_EFFORT: "high",
        });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
});

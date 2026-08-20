import type { RuntimeSetting } from "@prisma/client";
import { prisma } from "../core/db.ts";

async function list(environment: string) {
  return prisma.runtimeSetting.findMany({ where: { environment }, orderBy: { key: "asc" } });
}

async function upsertMany(environment: string, values: Array<{ key: string; value: string; secret: boolean }>) {
  return prisma.$transaction(values.map(({ key, value, secret }) => prisma.runtimeSetting.upsert({
    where: { environment_key: { environment, key } },
    create: { environment, key, value, secret },
    update: { value, secret },
  })));
}

async function removeMany(environment: string, keys: string[]) {
  return prisma.runtimeSetting.deleteMany({ where: { environment, key: { in: keys } } });
}

export const settingsRepository = { list, upsertMany, removeMany };
export type StoredRuntimeSetting = RuntimeSetting;

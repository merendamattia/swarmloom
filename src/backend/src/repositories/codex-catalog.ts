import { prisma } from "../core/db.ts";

async function listEnabled() {
  return prisma.codexModel.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: "asc" },
    include: {
      efforts: {
        where: { reasoningEffort: { enabled: true } },
        include: { reasoningEffort: true },
      },
    },
  });
}

export const codexCatalogRepository = { listEnabled };

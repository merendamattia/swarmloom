import { prisma } from "../core/db.ts";

const exceptionStatuses = ["FAILED", "BLOCKED", "STALE"] as const;

async function findAcknowledgement(environment: string) {
  return prisma.dashboardExceptionAcknowledgement.findUnique({ where: { environment } });
}

async function acknowledge(environment: string, acknowledgedAt = new Date()) {
  return prisma.dashboardExceptionAcknowledgement.upsert({
    where: { environment },
    create: { environment, acknowledgedAt },
    update: { acknowledgedAt },
  });
}

export const dashboardExceptionRepository = {
  findAcknowledgement,
  acknowledge,
  exceptionStatuses,
};

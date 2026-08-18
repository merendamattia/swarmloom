import type { EventLevel, Prisma } from "@prisma/client";
import { prisma } from "../core/db.ts";

export type RecordEventInput = {
  type: string;
  message: string;
  level?: EventLevel;
  jobId?: string;
  repositoryId?: string;
  scanRunId?: string;
  metadata?: Prisma.InputJsonValue;
  raw?: Prisma.InputJsonValue;
};

async function create(input: RecordEventInput) {
  return prisma.jobEvent.create({ data: input });
}

async function markNotified(id: string) {
  return prisma.jobEvent.update({ where: { id }, data: { notifiedAt: new Date(), notificationError: null } });
}

async function markNotificationFailed(id: string, error: string) {
  return prisma.jobEvent.update({ where: { id }, data: { notificationError: error.slice(0, 2_000) } });
}

export const eventRepository = { create, markNotified, markNotificationFailed };

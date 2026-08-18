import type { Prisma } from "@prisma/client";
import { prisma } from "../core/db.ts";

async function beat(
  serviceName: string,
  environment: string,
  instanceId: string,
  metadata?: Prisma.InputJsonValue,
) {
  return prisma.serviceHeartbeat.upsert({
    where: { serviceName_environment_instanceId: { serviceName, environment, instanceId } },
    create: { serviceName, environment, instanceId, metadata },
    update: { metadata, lastSeenAt: new Date() },
  });
}

export const heartbeatRepository = { beat };

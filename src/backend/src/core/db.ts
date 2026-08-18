import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { config } from "./config.ts";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const adapter = new PrismaPg({ connectionString: config.DATABASE_URL });

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  adapter,
  log: config.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
});

if (config.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

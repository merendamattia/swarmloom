import type { AgentProvider, Prisma, ReviewStatus } from "@prisma/client";
import { prisma } from "../core/db.ts";

async function start(
  jobId: string,
  provider: AgentProvider,
  model: string,
  reasoningEffort?: string | null,
) {
  return prisma.review.create({
    data: { jobId, provider, model, reasoningEffort, status: "RUNNING", startedAt: new Date() },
  });
}

async function finish(
  id: string,
  status: Extract<ReviewStatus, "PASSED" | "CHANGES_REQUESTED" | "FAILED">,
  input: {
    sessionId?: string | null;
    verdict?: Prisma.InputJsonValue;
    findings?: Prisma.InputJsonValue;
    exitCode?: number;
    errorMessage?: string;
  },
) {
  const review = await prisma.review.findUnique({ where: { id }, select: { startedAt: true } });
  const completedAt = new Date();
  const updated = await prisma.review.updateMany({
    where: { id, status: "RUNNING" },
    data: {
      status,
      ...input,
      completedAt,
      durationMs: review?.startedAt ? completedAt.getTime() - review.startedAt.getTime() : null,
    },
  });
  return updated.count === 1;
}

export const reviewRepository = { start, finish };

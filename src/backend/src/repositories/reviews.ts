import type { AgentProvider, ReviewStatus } from "@prisma/client";
import { prisma } from "../core/db.ts";

async function start(
  jobId: string,
  claimToken: string,
  provider: AgentProvider,
  model: string,
  reasoningEffort?: string | null,
  input: { pullRequestId?: string | null; pullRequestNumber?: number | null; headSha?: string | null } = {},
) {
  const startedAt = new Date();
  return prisma.$transaction(async (transaction) => {
    const [activeJob] = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "job"
      WHERE "id" = ${jobId}
        AND "status" = 'RUNNING'
        AND "claimToken" = ${claimToken}
      FOR UPDATE
    `;
    if (!activeJob) return null;

    return transaction.review.upsert({
      where: { jobId },
      create: {
        jobId,
        claimToken,
        provider,
        model,
        reasoningEffort,
        pullRequestId: input.pullRequestId ?? null,
        pullRequestNumber: input.pullRequestNumber ?? null,
        headSha: input.headSha ?? null,
        status: "RUNNING",
        startedAt,
      },
      update: {
        claimToken,
        provider,
        model,
        reasoningEffort,
        pullRequestId: input.pullRequestId ?? null,
        pullRequestNumber: input.pullRequestNumber ?? null,
        headSha: input.headSha ?? null,
        status: "RUNNING",
        response: null,
        exitCode: null,
        errorMessage: null,
        startedAt,
        completedAt: null,
        durationMs: null,
      },
    });
  });
}

async function finish(
  id: string,
  claimToken: string,
  status: Extract<ReviewStatus, "PASSED" | "CHANGES_REQUESTED" | "FAILED">,
  input: {
    sessionId?: string | null;
    response?: string;
    exitCode?: number;
    errorMessage?: string;
  },
) {
  return prisma.$transaction(async (transaction) => {
    const [activeJob] = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "job"
      WHERE "id" = (SELECT "jobId" FROM "review" WHERE "id" = ${id})
        AND "status" = 'RUNNING'
        AND "claimToken" = ${claimToken}
      FOR UPDATE
    `;
    if (!activeJob) return false;

    const review = await transaction.review.findFirst({
      where: { id, claimToken, status: "RUNNING" },
      select: { startedAt: true },
    });
    if (!review) return false;
    const completedAt = new Date();
    const updated = await transaction.review.updateMany({
      where: { id, claimToken, status: "RUNNING" },
      data: {
        status,
        ...input,
        completedAt,
        durationMs: review.startedAt ? completedAt.getTime() - review.startedAt.getTime() : null,
      },
    });
    return updated.count === 1;
  });
}

export const reviewRepository = { start, finish };

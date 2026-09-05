import { Prisma, type AgentProvider, type ReviewStatus } from "@prisma/client";
import { prisma } from "../core/db.ts";

function runningData(
  provider: AgentProvider,
  model: string,
  reasoningEffort: string | null | undefined,
  input: { pullRequestId?: string | null; pullRequestNumber?: number | null; headSha?: string | null },
  startedAt: Date,
  claimToken: string,
) {
  return {
    provider,
    model,
    reasoningEffort,
    pullRequestId: input.pullRequestId ?? null,
    pullRequestNumber: input.pullRequestNumber ?? null,
    headSha: input.headSha ?? null,
    status: "RUNNING" as const,
    claimToken,
    response: null,
    exitCode: null,
    errorMessage: null,
    startedAt,
    completedAt: null,
    durationMs: null,
  };
}

async function start(
  jobId: string,
  provider: AgentProvider,
  model: string,
  claimToken: string,
  reasoningEffort?: string | null,
  input: { pullRequestId?: string | null; pullRequestNumber?: number | null; headSha?: string | null } = {},
) {
  const startedAt = new Date();
  const data = runningData(provider, model, reasoningEffort, input, startedAt, claimToken);
  const where = {
    jobId,
    job: { is: { status: "RUNNING" as const, claimToken } },
  };
  const updated = await prisma.review.updateMany({ where, data });
  if (updated.count === 1) return prisma.review.findUnique({ where: { jobId } });

  try {
    return await prisma.review.create({ data: { jobId, ...data } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const retried = await prisma.review.updateMany({ where, data });
    return retried.count === 1 ? prisma.review.findUnique({ where: { jobId } }) : null;
  }
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
  const where = {
    id,
    status: "RUNNING" as const,
    claimToken,
    job: { is: { status: "RUNNING" as const, claimToken } },
  };
  const review = await prisma.review.findFirst({ where, select: { startedAt: true } });
  if (!review) return false;
  const completedAt = new Date();
  const updated = await prisma.review.updateMany({
    where,
    data: {
      status,
      ...input,
      completedAt,
      durationMs: review?.startedAt ? completedAt.getTime() - review.startedAt.getTime() : null,
    },
  });
  return updated.count === 1;
}

const cancellationMessage = "Review cancelled because its quota-waiting job was cancelled by an operator.";
const staleMessage = "Review discarded because the pull request head moved while the review was waiting for quota.";

async function failForJob(jobId: string, errorMessage: string, claimToken?: string) {
  const where = {
    jobId,
    status: "RUNNING" as const,
    ...(claimToken === undefined ? {} : { job: { is: { status: "RUNNING" as const, claimToken } } }),
  };
  const review = await prisma.review.findFirst({ where, select: { id: true, startedAt: true } });
  if (!review) return false;
  const completedAt = new Date();
  const updated = await prisma.review.updateMany({
    where: {
      id: review.id,
      status: "RUNNING",
      ...(claimToken === undefined ? {} : { job: { is: { status: "RUNNING" as const, claimToken } } }),
    },
    data: {
      status: "FAILED",
      errorMessage,
      completedAt,
      durationMs: review.startedAt ? Math.max(0, completedAt.getTime() - review.startedAt.getTime()) : null,
    },
  });
  return updated.count === 1;
}

async function cancelForJob(jobId: string, errorMessage = cancellationMessage) {
  return failForJob(jobId, errorMessage);
}

async function failStaleForJob(jobId: string, claimToken: string) {
  return failForJob(jobId, staleMessage, claimToken);
}

async function reconcileCancelledJobs(environment: string) {
  const reviews = await prisma.review.findMany({
    where: { status: "RUNNING", job: { is: { environment, status: "CANCELLED" } } },
    select: { jobId: true },
  });
  let finalized = 0;
  for (const review of reviews) {
    if (await cancelForJob(review.jobId)) finalized += 1;
  }
  return finalized;
}

export const reviewRepository = { start, finish, cancelForJob, failStaleForJob, reconcileCancelledJobs };

import type { AgentProvider, ReviewStatus } from "@prisma/client";
import { prisma } from "../core/db.ts";

async function start(
  jobId: string,
  provider: AgentProvider,
  model: string,
  reasoningEffort?: string | null,
  input: { pullRequestId?: string | null; pullRequestNumber?: number | null; headSha?: string | null } = {},
) {
  const startedAt = new Date();
  return prisma.review.upsert({
    where: { jobId },
    create: {
      jobId,
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
}

async function finish(
  id: string,
  status: Extract<ReviewStatus, "PASSED" | "CHANGES_REQUESTED" | "FAILED">,
  input: {
    sessionId?: string | null;
    response?: string;
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

const cancellationMessage = "Review cancelled because its quota-waiting job was cancelled by an operator.";
const staleMessage = "Review discarded because the pull request head moved while the review was waiting for quota.";

async function failForJob(jobId: string, errorMessage: string) {
  const review = await prisma.review.findUnique({ where: { jobId }, select: { id: true, startedAt: true } });
  if (!review) return false;
  const completedAt = new Date();
  const updated = await prisma.review.updateMany({
    where: { id: review.id, status: "RUNNING" },
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

async function failStaleForJob(jobId: string) {
  return failForJob(jobId, staleMessage);
}

async function reconcileCancelledJobs() {
  const reviews = await prisma.review.findMany({
    where: { status: "RUNNING", job: { status: "CANCELLED" } },
    select: { jobId: true },
  });
  let finalized = 0;
  for (const review of reviews) {
    if (await cancelForJob(review.jobId)) finalized += 1;
  }
  return finalized;
}

export const reviewRepository = { start, finish, cancelForJob, failStaleForJob, reconcileCancelledJobs };

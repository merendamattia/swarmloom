-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('IMPLEMENTATION', 'FIX', 'REVIEW', 'DECOMPOSITION');

-- CreateEnum
CREATE TYPE "JobSubject" AS ENUM ('ISSUE', 'PULL_REQUEST');

-- CreateEnum
CREATE TYPE "ManagedPrState" AS ENUM ('OPEN', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ManagedPrWorkflow" AS ENUM ('NONE', 'REVIEW_REQUESTED', 'FIX_REQUESTED', 'REVIEW_PASSED');

-- DropForeignKey
ALTER TABLE "job" DROP CONSTRAINT "job_repositoryId_fkey";

-- DropForeignKey
ALTER TABLE "job" DROP CONSTRAINT "job_scanRunId_fkey";

-- DropForeignKey
ALTER TABLE "job_event" DROP CONSTRAINT "job_event_jobId_fkey";

-- DropForeignKey
ALTER TABLE "job_event" DROP CONSTRAINT "job_event_repositoryId_fkey";

-- DropForeignKey
ALTER TABLE "job_event" DROP CONSTRAINT "job_event_scanRunId_fkey";

-- DropForeignKey
ALTER TABLE "review" DROP CONSTRAINT "review_jobId_fkey";

-- AlterTable
ALTER TABLE "job" ADD COLUMN     "activePrKey" TEXT,
ADD COLUMN     "headSha" TEXT,
ADD COLUMN     "jobType" "JobType" NOT NULL DEFAULT 'IMPLEMENTATION',
ADD COLUMN     "pullRequestId" TEXT,
ADD COLUMN     "subjectType" "JobSubject" NOT NULL DEFAULT 'ISSUE',
ADD COLUMN     "trigger" TEXT;

-- AlterTable
ALTER TABLE "review" ADD COLUMN     "headSha" TEXT,
ADD COLUMN     "pullRequestId" TEXT,
ADD COLUMN     "pullRequestNumber" INTEGER;

-- CreateTable
CREATE TABLE "managed_pull_request" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "issueTitle" TEXT NOT NULL,
    "issueUrl" TEXT NOT NULL,
    "headBranch" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "implementationJobId" TEXT,
    "state" "ManagedPrState" NOT NULL DEFAULT 'OPEN',
    "workflow" "ManagedPrWorkflow" NOT NULL DEFAULT 'NONE',
    "fixReason" TEXT,
    "fixDetails" TEXT,
    "fixCycleCount" INTEGER NOT NULL DEFAULT 0,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "lastObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_pull_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "managed_pull_request_repositoryId_state_idx" ON "managed_pull_request"("repositoryId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "managed_pull_request_repositoryId_prNumber_key" ON "managed_pull_request"("repositoryId", "prNumber");

-- CreateIndex
CREATE UNIQUE INDEX "job_activePrKey_key" ON "job"("activePrKey");

-- CreateIndex
CREATE INDEX "job_repositoryId_pullRequestNumber_idx" ON "job"("repositoryId", "pullRequestNumber");

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_scanRunId_fkey" FOREIGN KEY ("scanRunId") REFERENCES "scan_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "managed_pull_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_pull_request" ADD CONSTRAINT "managed_pull_request_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "managed_pull_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_event" ADD CONSTRAINT "job_event_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_event" ADD CONSTRAINT "job_event_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_event" ADD CONSTRAINT "job_event_scanRunId_fkey" FOREIGN KEY ("scanRunId") REFERENCES "scan_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

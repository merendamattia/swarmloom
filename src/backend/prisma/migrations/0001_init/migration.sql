CREATE TYPE "RepositoryStatus" AS ENUM ('PENDING', 'READY', 'INVALID', 'ERROR');
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED', 'DECOMPOSED', 'CANCELLED', 'STALE');
CREATE TYPE "AgentProvider" AS ENUM ('CODEX', 'OPENCODE');
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'CHANGES_REQUESTED', 'FAILED');
CREATE TYPE "ScanSource" AS ENUM ('SCHEDULED', 'MANUAL');
CREATE TYPE "ScanStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');
CREATE TYPE "EventLevel" AS ENUM ('INFO', 'WARNING', 'ERROR');

CREATE TABLE "repository" (
  "id" TEXT PRIMARY KEY,
  "fullName" TEXT NOT NULL,
  "cloneUrl" TEXT NOT NULL,
  "localPath" TEXT,
  "status" "RepositoryStatus" NOT NULL DEFAULT 'PENDING',
  "developAvailable" BOOLEAN NOT NULL DEFAULT false,
  "baselineCommit" TEXT,
  "lastScannedAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "repository_fullName_key" ON "repository"("fullName");
CREATE INDEX "repository_status_fullName_idx" ON "repository"("status", "fullName");

CREATE TABLE "job" (
  "id" TEXT PRIMARY KEY,
  "repositoryId" TEXT NOT NULL,
  "issueNumber" INTEGER NOT NULL,
  "issueTitle" TEXT NOT NULL,
  "issueUrl" TEXT NOT NULL,
  "issueBody" TEXT NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
  "activeIssueKey" TEXT,
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "branchName" TEXT NOT NULL,
  "worktreePath" TEXT,
  "baselineCommit" TEXT NOT NULL,
  "pullRequestNumber" INTEGER,
  "pullRequestUrl" TEXT,
  "provider" "AgentProvider" NOT NULL,
  "model" TEXT NOT NULL,
  "reasoningEffort" TEXT,
  "implementationSessionId" TEXT,
  "exitCode" INTEGER,
  "result" JSONB,
  "errorMessage" TEXT,
  "workerId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "heartbeatAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "job_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repository"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "job_activeIssueKey_key" ON "job"("activeIssueKey");
CREATE INDEX "job_repositoryId_issueNumber_createdAt_idx" ON "job"("repositoryId", "issueNumber", "createdAt");
CREATE INDEX "job_status_queuedAt_idx" ON "job"("status", "queuedAt");
CREATE INDEX "job_provider_createdAt_idx" ON "job"("provider", "createdAt");

CREATE TABLE "review" (
  "id" TEXT PRIMARY KEY,
  "jobId" TEXT NOT NULL,
  "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
  "provider" "AgentProvider" NOT NULL,
  "model" TEXT NOT NULL,
  "reasoningEffort" TEXT,
  "sessionId" TEXT,
  "verdict" JSONB,
  "findings" JSONB,
  "exitCode" INTEGER,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "review_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "review_jobId_key" ON "review"("jobId");
CREATE INDEX "review_status_createdAt_idx" ON "review"("status", "createdAt");

CREATE TABLE "scan_run" (
  "id" TEXT PRIMARY KEY,
  "source" "ScanSource" NOT NULL,
  "status" "ScanStatus" NOT NULL DEFAULT 'RUNNING',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "repositoriesTotal" INTEGER NOT NULL DEFAULT 0,
  "queuedCount" INTEGER NOT NULL DEFAULT 0,
  "successCount" INTEGER NOT NULL DEFAULT 0,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "blockedCount" INTEGER NOT NULL DEFAULT 0,
  "decomposedCount" INTEGER NOT NULL DEFAULT 0,
  "pullRequestsCount" INTEGER NOT NULL DEFAULT 0,
  "reviewsCount" INTEGER NOT NULL DEFAULT 0,
  "queueRemaining" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "scan_run_startedAt_idx" ON "scan_run"("startedAt");

CREATE TABLE "job_event" (
  "id" TEXT PRIMARY KEY,
  "jobId" TEXT,
  "repositoryId" TEXT,
  "scanRunId" TEXT,
  "type" TEXT NOT NULL,
  "level" "EventLevel" NOT NULL DEFAULT 'INFO',
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "raw" JSONB,
  "notifiedAt" TIMESTAMP(3),
  "notificationError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "job_event_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE CASCADE,
  CONSTRAINT "job_event_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repository"("id") ON DELETE RESTRICT,
  CONSTRAINT "job_event_scanRunId_fkey" FOREIGN KEY ("scanRunId") REFERENCES "scan_run"("id") ON DELETE CASCADE
);
CREATE INDEX "job_event_jobId_createdAt_idx" ON "job_event"("jobId", "createdAt");
CREATE INDEX "job_event_repositoryId_createdAt_idx" ON "job_event"("repositoryId", "createdAt");
CREATE INDEX "job_event_scanRunId_createdAt_idx" ON "job_event"("scanRunId", "createdAt");
CREATE INDEX "job_event_notifiedAt_createdAt_idx" ON "job_event"("notifiedAt", "createdAt");

CREATE TABLE "service_heartbeat" (
  "id" TEXT PRIMARY KEY,
  "serviceName" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "instanceId" TEXT NOT NULL,
  "metadata" JSONB,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "service_heartbeat_serviceName_environment_instanceId_key" ON "service_heartbeat"("serviceName", "environment", "instanceId");
CREATE INDEX "service_heartbeat_environment_lastSeenAt_idx" ON "service_heartbeat"("environment", "lastSeenAt");

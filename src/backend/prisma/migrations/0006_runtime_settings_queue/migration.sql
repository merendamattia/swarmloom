ALTER TABLE "job" ADD COLUMN "queueJobId" TEXT;
UPDATE "job" SET "queueJobId" = "id" WHERE "queueJobId" IS NULL;
ALTER TABLE "job" ALTER COLUMN "queueJobId" SET NOT NULL;
CREATE UNIQUE INDEX "job_queueJobId_key" ON "job"("queueJobId");

CREATE TABLE "runtime_setting" (
  "id" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "secret" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "runtime_setting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "runtime_setting_environment_key_key" ON "runtime_setting"("environment", "key");
CREATE INDEX "runtime_setting_environment_updatedAt_idx" ON "runtime_setting"("environment", "updatedAt");

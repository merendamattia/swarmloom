-- Persist the last dashboard exception acknowledgement per environment.
CREATE TABLE "dashboard_exception_acknowledgement" (
  "environment" TEXT NOT NULL,
  "acknowledgedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dashboard_exception_acknowledgement_pkey" PRIMARY KEY ("environment")
);

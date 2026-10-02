-- Preserve historical job types, terminal statuses, results, and events. Stop unfinished
-- decomposition jobs so they cannot be delivered after the upgrade.
UPDATE "job"
SET "status" = 'BLOCKED',
    "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
    "errorMessage" = 'The decomposition workflow was removed; this issue requires human intervention.',
    "activeIssueKey" = NULL,
    "activePrKey" = NULL,
    "worktreeCleanupRequired" = ("worktreePath" IS NOT NULL),
    "workerId" = NULL,
    "claimToken" = NULL,
    "heartbeatAt" = NULL,
    "activeStartedAt" = NULL,
    "quotaWaitStartedAt" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "jobType" = 'DECOMPOSITION'
  AND "status" IN ('QUEUED', 'RUNNING', 'WAITING_FOR_QUOTA');

DELETE FROM "runtime_setting" WHERE "key" = 'ISSUE_DECOMPOSED_LABEL';

-- A legacy enum value remains readable, but cannot be used for new work.
CREATE FUNCTION reject_decomposition_job() RETURNS trigger AS $$
BEGIN
  IF NEW."jobType" = 'DECOMPOSITION' THEN
    RAISE EXCEPTION 'Decomposition jobs are no longer supported';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reject_decomposition_job_insert
BEFORE INSERT ON "job"
FOR EACH ROW EXECUTE FUNCTION reject_decomposition_job();

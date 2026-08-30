type RecoveryEvent = {
  type: string;
  metadata: unknown;
};

export type RecoveryJob = {
  attempts: number;
  sessionId: string | null;
  events: RecoveryEvent[];
};

export function recoveryLabel(job: RecoveryJob) {
  const latestRequest = [...job.events]
    .reverse()
    .find((event) => event.type === "JOB_RESUME_REQUESTED");
  const requestMetadata = latestRequest ? metadataRecord(latestRequest.metadata) : undefined;
  if (requestMetadata?.sessionResumed === false) return "Restarted without session";
  if (requestMetadata?.sessionResumed === true) {
    const resumed = job.events.some((event) => {
      if (event.type !== "SESSION_RESUMED") return false;
      const metadata = metadataRecord(event.metadata);
      return metadata?.attempt === requestMetadata.attempt
        && metadata?.sessionId === requestMetadata.sessionId;
    });
    return resumed ? "Session resumed" : "Session resume queued";
  }
  if (job.attempts <= 1) return "Initial execution";
  return job.sessionId ? "Session resumed" : "Restarted without session";
}

function metadataRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

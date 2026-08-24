import { redactSecrets } from "../core/secrets.ts";
import { eventRepository, type RecordEventInput } from "../repositories/events.ts";

const notifiableTypes = new Set([
  "SCAN_FAILED",
  "JOB_STARTED",
  "JOB_FAILED",
  "JOB_BLOCKED",
  "JOB_DECOMPOSED",
  "JOB_CANCELLED",
  "JOB_RETRY_REQUESTED",
  "REPOSITORY_INVALID",
  "REPOSITORY_ERROR",
  "GITHUB_RECONCILIATION_REQUIRED",
  "PR_OPENED",
  "PR_FIX_REQUESTED",
  "READY_TO_MERGE",
  "PR_MERGED",
  "LOOP_GUARD_TRIPPED",
  "TELEGRAM_TEST",
]);

export type QueuedJobInfo = {
  repository: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl?: string | null;
  jobId?: string | null;
  jobType?: string | null;
  pullRequestNumber?: number | null;
};

type EventNotifier = {
  send(event: Awaited<ReturnType<typeof eventRepository.create>>): Promise<void>;
  sendQueued?(summary: { scanRunId: string; jobs: QueuedJobInfo[] }): Promise<void>;
  enabled?: () => boolean;
};

export function createEventService(notifier?: EventNotifier) {
  return {
    async record(input: RecordEventInput) {
      const event = await eventRepository.create(input);
      if (!notifier || !notifiableTypes.has(event.type) || notifier.enabled?.() === false) return event;
      try {
        await notifier.send(event);
        return await eventRepository.markNotified(event.id);
      } catch (error) {
        await eventRepository.markNotificationFailed(
          event.id,
          redactSecrets(error instanceof Error ? error.message : String(error)),
        );
        return event;
      }
    },
    async notifyQueuedSummary(scanRunId: string, jobs: QueuedJobInfo[]) {
      if (!notifier?.sendQueued || notifier.enabled?.() === false || jobs.length === 0) return;
      try {
        await notifier.sendQueued({ scanRunId, jobs });
        await eventRepository.markQueuedNotified(scanRunId);
      } catch (error) {
        await eventRepository.markQueuedNotificationFailed(
          scanRunId,
          redactSecrets(error instanceof Error ? error.message : String(error)),
        );
      }
    },
  };
}

export type EventService = ReturnType<typeof createEventService>;

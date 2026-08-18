import { redactSecrets } from "../core/secrets.ts";
import { eventRepository, type RecordEventInput } from "../repositories/events.ts";

const notifiableTypes = new Set([
  "JOB_STARTED",
  "JOB_COMPLETED",
  "JOB_FAILED",
  "JOB_BLOCKED",
  "JOB_DECOMPOSED",
  "REPOSITORY_INVALID",
  "REVIEW_COMPLETED",
  "SCAN_COMPLETED",
  "TELEGRAM_TEST",
]);

type EventNotifier = {
  send(event: Awaited<ReturnType<typeof eventRepository.create>>): Promise<void>;
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
  };
}

export type EventService = ReturnType<typeof createEventService>;

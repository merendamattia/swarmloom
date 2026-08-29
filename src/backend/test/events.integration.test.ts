import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("event notification policy", () => {
  let prisma: typeof import("../src/core/db.ts").prisma;
  let createEventService: typeof import("../src/events/service.ts").createEventService;
  const eventIds: string[] = [];

  beforeAll(async () => {
    ({ prisma } = await import("../src/core/db.ts"));
    ({ createEventService } = await import("../src/events/service.ts"));
  });

  afterAll(async () => {
    await prisma.jobEvent.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.$disconnect();
  });

  test("persists suppressed lifecycle events while notifying only actionable outcomes", async () => {
    const sent: string[] = [];
    const events = createEventService({
      enabled: () => true,
      send: async (event) => { sent.push(event.type); },
    });
    const allowedTypes = [
      "SCAN_FAILED",
      "JOB_STARTED",
      "JOB_FAILED",
      "JOB_BLOCKED",
      "JOB_DECOMPOSED",
      "JOB_CANCELLED",
      "JOB_RETRY_REQUESTED",
      "JOB_RESUME_REQUESTED",
      "REPOSITORY_INVALID",
      "REPOSITORY_ERROR",
      "GITHUB_RECONCILIATION_REQUIRED",
      "PR_OPENED",
      "PR_FIX_REQUESTED",
      "READY_TO_MERGE",
      "PR_MERGED",
      "LOOP_GUARD_TRIPPED",
      "TELEGRAM_TEST",
    ];
    const suppressedTypes = [
      "JOB_COMPLETED",
      "PR_REVIEW_REQUESTED",
      "REVIEW_COMPLETED",
      "REVIEW_PASSED",
      "ISSUE_DONE",
    ];
    const types = [...allowedTypes, ...suppressedTypes];

    const recorded = [];
    for (const type of types) {
      recorded.push(await events.record({ type, message: `${type} details` }));
    }
    eventIds.push(...recorded.map(({ id }) => id));

    expect(sent).toEqual(allowedTypes);
    const stored = await prisma.jobEvent.findMany({ where: { id: { in: eventIds } } });
    expect(stored).toHaveLength(types.length);
    expect(stored.filter(({ type }) => suppressedTypes.includes(type))).toEqual(
      expect.arrayContaining(suppressedTypes.map((type) => expect.objectContaining({ type, notifiedAt: null, notificationError: null }))),
    );
    expect(stored.filter(({ type }) => allowedTypes.includes(type)).every(({ notifiedAt }) => notifiedAt !== null)).toBe(true);
  });
});

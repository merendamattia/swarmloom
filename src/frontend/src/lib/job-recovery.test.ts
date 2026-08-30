import { expect, test } from "bun:test";
import { recoveryLabel } from "./job-recovery";

test("uses the latest retry metadata instead of historical resume events", () => {
  const job = {
    attempts: 3,
    sessionId: "fresh-session",
    events: [
      { type: "JOB_RESUME_REQUESTED", metadata: { attempt: 2, sessionId: "old-session", sessionResumed: true } },
      { type: "SESSION_RESUMED", metadata: { attempt: 2, sessionId: "old-session" } },
      { type: "JOB_RESUME_REQUESTED", metadata: { attempt: 3, sessionResumed: false } },
      { type: "SESSION_STARTED", metadata: { attempt: 3, sessionResumed: false, sessionId: "fresh-session" } },
    ],
  };

  expect(recoveryLabel(job)).toBe("Restarted without session");
});

test("reports a current resumed attempt only when its own resume event exists", () => {
  expect(recoveryLabel({
    attempts: 2,
    sessionId: "session-2",
    events: [
      { type: "JOB_RESUME_REQUESTED", metadata: { attempt: 2, sessionId: "session-2", sessionResumed: true } },
      { type: "SESSION_RESUMED", metadata: { attempt: 2, sessionId: "session-2" } },
    ],
  })).toBe("Session resumed");
});

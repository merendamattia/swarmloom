import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../src/core/secrets.ts";
import { implementationContext } from "../src/runner/helpers.ts";

describe("implementation context", () => {
  test("keeps the canonical issue reference trusted when live context URLs are redacted", () => {
    const issueNumber = 123;
    const issueUrl = `https://github.com/acme/runner/issues/${issueNumber}`;
    const job = {
      issueNumber,
      issueTitle: "Issue",
      issueUrl,
      issueBody: "Acceptance criteria",
      baselineCommit: "a".repeat(40),
      branchName: "agent/issue-123",
      repository: { fullName: "acme/runner" },
    } as Parameters<typeof implementationContext>[0];
    const liveContext = {
      issue: { number: issueNumber, title: "Issue", body: "", url: issueUrl, labels: [] },
      issueComments: [],
      pullRequests: [],
    };

    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "acme/runner";
    try {
      const context = implementationContext(job, liveContext);
      const redactedLiveUrl = redactSecrets(issueUrl, { GITHUB_TOKEN: "acme/runner" });

      expect(redactedLiveUrl).toBe("https://github.com/[REDACTED]/issues/123");
      expect(context).toContain("Canonical same-repository PR reference: `Closes #123`");
      expect(context).toContain(redactedLiveUrl);
      expect(context).not.toContain("Canonical same-repository PR reference: `Closes #[REDACTED]`");
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
    }
  });
});

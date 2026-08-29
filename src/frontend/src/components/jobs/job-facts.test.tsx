import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JobFacts } from "./job-facts";

describe("JobFacts", () => {
  test("labels provider token accounting and preserves missing values", () => {
    const html = renderToStaticMarkup(<JobFacts
      subject="Issue #42"
      trigger="issue ready"
      job={{
        jobType: "IMPLEMENTATION",
        provider: "CODEX",
        model: "gpt-5",
        reasoningEffort: "high",
        attempts: 1,
        exitCode: 0,
        durationMs: 1_000,
        workerId: "worker-1",
        implementationSessionId: "thread-1",
        baselineCommit: "a".repeat(40),
        branchName: "agent/issue-42",
        pullRequestNumber: null,
        headSha: null,
        queuedAt: null,
        startedAt: null,
        completedAt: null,
        heartbeatAt: null,
        usage: {
          inputTokens: 1_000,
          cachedInputTokens: null,
          outputTokens: 120,
          reasoningOutputTokens: 80,
          totalTokens: 1_120,
        },
      } as never}
    />);

    expect(html).toContain("Token usage");
    expect(html).toContain("Input / consumed");
    expect(html).toContain("1,000");
    expect(html).toContain("Output / generated");
    expect(html).toContain("1,120");
    expect(html).toContain("Cached input");
    expect(html).toContain("Not recorded");
  });
});

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JobTable } from "./job-table";

const job = {
  id: "job-1",
  status: "COMPLETED",
  jobType: "IMPLEMENTATION",
  subjectType: "ISSUE",
  issueNumber: 42,
  pullRequestNumber: null,
  issueTitle: "Keep the operational history readable",
  pullRequestUrl: null,
  headSha: "1234567890abcdef",
  trigger: "issue_ready",
  review: null,
  repository: { fullName: "acme/control-plane" },
  provider: "CODEX",
  model: "gpt-5.6-luna",
  reasoningEffort: "high",
  durationMs: 91_000,
  createdAt: "2026-08-28T08:00:00.000Z",
};

describe("JobTable", () => {
  test("groups durable job identity, agent, and timing without a duplicate details action", () => {
    const html = renderToStaticMarkup(<JobTable jobs={[job as never]} />);

    expect(html).toContain(">Job</th>");
    expect(html).toContain("<th>Agent</th>");
    expect(html).toContain("<th>Timing</th>");
    expect(html).toContain("High reasoning");
    expect(html).toContain('data-label="Job"');
    expect(html).not.toContain("<th>Subject</th>");
    expect(html).not.toContain(">Inspect<");
  });

  test("keeps agent reasoning visible in the overview variant", () => {
    const html = renderToStaticMarkup(<JobTable jobs={[job as never]} compact />);

    expect(html).toContain("Five most recent jobs");
    expect(html).toContain("<th>Agent</th>");
    expect(html).toContain("High reasoning");
    expect(html).toContain("<th>Started</th>");
    expect(html).not.toContain("<th>Timing</th>");
  });
});

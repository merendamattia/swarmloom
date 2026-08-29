import { FactList } from "@/components/ui/fact-list";
import { SectionHeading } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import type { Job } from "@/hooks/api";
import { dateTime, duration, formatTokens, shortCommit, statusLabel } from "@/lib/format";

export function JobFacts({ job, subject, trigger }: { job: Job; subject: string; trigger: string | null }) {
  return (
    <aside className="detail-aside" aria-label="Job facts">
      <Panel>
        <SectionHeading title="Execution" />
        <FactList items={[
          { label: "Job kind", value: statusLabel(job.jobType) },
          { label: "Subject", value: subject },
          ...(trigger ? [{ label: "Trigger", value: trigger }] : []),
          { label: "Provider", value: statusLabel(job.provider) },
          { label: "Model", value: job.model },
          { label: "Reasoning", value: job.reasoningEffort ?? "Provider default" },
          { label: "Attempt", value: job.attempts },
          { label: "Exit code", value: job.exitCode ?? "Not recorded" },
          { label: "Duration", value: duration(job.durationMs) },
          { label: "Worker", value: job.workerId ?? "Not assigned" },
          { label: "Session", value: job.implementationSessionId ?? "Not recorded", mono: true },
        ]} />
      </Panel>
      <Panel>
        <SectionHeading title="Token usage" description="Provider-reported cumulative usage; missing fields are not inferred." />
        <FactList items={[
          { label: "Input / consumed", value: formatTokens(job.usage.inputTokens) },
          { label: "Cached input", value: formatTokens(job.usage.cachedInputTokens) },
          { label: "Output / generated", value: formatTokens(job.usage.outputTokens) },
          { label: "Reasoning output", value: formatTokens(job.usage.reasoningOutputTokens) },
          { label: "Total tokens", value: formatTokens(job.usage.totalTokens) },
        ]} />
      </Panel>
      <Panel>
        <SectionHeading title="Git context" />
        <FactList items={[
          { label: "Required base", value: "develop" },
          { label: "Baseline", value: shortCommit(job.baselineCommit), mono: true, title: job.baselineCommit },
          { label: "Branch", value: job.branchName, mono: true },
          { label: "Pull request", value: job.pullRequestNumber ? `#${job.pullRequestNumber}` : "Not opened" },
          { label: "Head SHA", value: shortCommit(job.headSha), mono: true, title: job.headSha ?? undefined },
        ]} />
      </Panel>
      <Panel>
        <SectionHeading title="Lifecycle" />
        <FactList items={[
          { label: "Queued", value: dateTime(job.queuedAt) },
          { label: "Started", value: dateTime(job.startedAt) },
          { label: "Completed", value: dateTime(job.completedAt) },
          { label: "Heartbeat", value: dateTime(job.heartbeatAt) },
        ]} />
      </Panel>
    </aside>
  );
}

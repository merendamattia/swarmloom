import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeading } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import type { Job } from "@/hooks/api";
import { agentOutputMessage, dateTime } from "@/lib/format";
import { MarkdownText, ReviewEvidence } from "@/components/jobs/job-evidence";

type AgentEvent = Job["events"][number];

export function JobTimeline({ job, events }: { job: Job; events: AgentEvent[] }) {
  return (
    <Panel>
      <SectionHeading title="Timeline" description={job.status === "RUNNING" ? "Polling every two seconds while this job remains active." : "Only non-empty agent output, in chronological order."} />
      {events.length ? <ol className="timeline">{events.map((event) => <li className="timeline-item" data-level={event.level} key={event.id}><span className="timeline-dot" aria-hidden="true" /><div className="timeline-copy"><div className="timeline-head"><strong>Agent output</strong><time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time></div><MarkdownText value={agentOutputMessage(event.message, job.pullRequestUrl)} /></div></li>)}</ol> : <EmptyState title="No agent output recorded" description="Agent messages will appear here as the worker progresses." />}
    </Panel>
  );
}

export function JobResult({ status, result }: { status: string; result: string | null }) {
  return <Panel><SectionHeading title="Result" description="The agent response retained with this immutable attempt." />{result ? <div className="response-evidence"><MarkdownText value={result} /></div> : status === "RUNNING" ? <EmptyState tone="active" title="Result pending" description="The provider has not returned its response yet." /> : <EmptyState title="No result recorded" description="Use the timeline and error evidence above for this attempt." />}</Panel>;
}

export function JobReview({ job, response }: { job: Job; response: string | null }) {
  return <Panel><SectionHeading title="Automated review" description="Review sessions are independent durable jobs; this evidence belongs to the review job that owns it." />{job.review ? <ReviewEvidence review={job.review} response={response} /> : <EmptyState title="No review recorded" description={job.jobType === "REVIEW" ? "This review job did not persist a review result." : "Reviews run as separate jobs with their own history."} />}</Panel>;
}

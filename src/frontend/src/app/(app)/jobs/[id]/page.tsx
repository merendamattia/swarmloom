"use client";

import {
  Ban,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ActionMessage,
  EmptyState,
  JobKindPill,
  PageError,
  PageSkeleton,
  SectionHeading,
  StatusPill,
} from "@/components/operational";
import { useCancelJob, useJob, useRetryJob } from "@/hooks/api";
import {
  agentOutputEvents,
  agentOutputMessage,
  dateTime,
  duration,
  inlineMarkdown,
  shortCommit,
  statusLabel,
  subjectLabel,
  triggerLabel,
} from "@/lib/format";

const cancellable = new Set(["QUEUED", "RUNNING"]);
const retryable = new Set(["FAILED", "BLOCKED", "CANCELLED", "STALE"]);

export default function JobPage() {
  const id = String(useParams<{ id: string }>().id);
  const job = useJob(id);
  const cancel = useCancelJob(id);
  const retry = useRetryJob(id);

  if (job.isPending) return <PageSkeleton label="Loading job evidence" />;
  if (job.error || !job.data) return <PageError error={job.error} retry={() => void job.refetch()} />;
  const data = job.data;
  const events = agentOutputEvents(data.events);
  const result = typeof data.result === "string" && data.result.trim() ? data.result : null;
  const review = typeof data.review?.response === "string" && data.review.response.trim() ? data.review.response : null;
  const trigger = triggerLabel(data.trigger);
  const subject = subjectLabel(data.subjectType, data.issueNumber, data.pullRequestNumber);

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/jobs">Jobs</Link><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">{data.repository.fullName} {subject}</span></nav>
      <header className="page-header">
        <div className="job-heading">
          <p className="eyebrow">Job evidence</p>
          <h1>{data.issueTitle}</h1>
          <div className="job-context"><StatusPill status={data.status} /><JobKindPill jobType={data.jobType} /><a href={data.issueUrl} target="_blank" rel="noreferrer">{subject} · issue #{data.issueNumber} <ExternalLink size={13} aria-hidden="true" /></a><span className="mono">{data.id}</span></div>
        </div>
        <div className="page-actions">
          {cancellable.has(data.status) ? <button className="button danger" type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending}><Ban size={16} aria-hidden="true" />{cancel.isPending ? "Cancelling…" : "Cancel job"}</button> : null}
          {retryable.has(data.status) ? <button className="button primary" type="button" onClick={() => retry.mutate()} disabled={retry.isPending}><RotateCcw size={16} aria-hidden="true" />{retry.isPending ? "Requesting retry…" : "Retry job"}</button> : null}
          {data.pullRequestUrl ? <a className="button secondary" href={data.pullRequestUrl} target="_blank" rel="noreferrer"><GitPullRequest size={16} aria-hidden="true" />Open PR</a> : null}
        </div>
      </header>
      <ActionMessage pending={cancel.isPending || retry.isPending} error={cancel.error || retry.error} success={cancel.isSuccess || retry.isSuccess} pendingText={cancel.isPending ? "Cancelling the job…" : data.subjectType === "PULL_REQUEST" ? "Restoring the pull request label and starting a scan…" : "Restoring the ready label and starting a scan…"} />

      {data.errorMessage ? <div className="notice" role="alert"><CircleAlert size={20} aria-hidden="true" /><div><strong>The job requires attention</strong><p>{data.errorMessage}</p></div></div> : null}

      <div className="detail-grid">
        <div className="detail-main">
          <section className="panel">
            <SectionHeading title="Timeline" description={data.status === "RUNNING" ? "Polling every two seconds while this job remains active." : "Only non-empty agent output, in chronological order."} />
            {events.length ? <ol className="timeline">{events.map((event) => <li className="timeline-item" data-level={event.level} key={event.id}><span className="timeline-dot" aria-hidden="true" /><div className="timeline-copy"><div className="timeline-head"><strong>Agent output</strong><time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time></div><MarkdownText value={agentOutputMessage(event.message, data.pullRequestUrl)} /></div></li>)}</ol> : <EmptyState title="No agent output recorded" description="Agent messages will appear here as the worker progresses." />}
          </section>

          <section className="panel">
            <SectionHeading title="Result" description="The agent response retained with this immutable attempt." />
            {result ? <div className="response-evidence"><MarkdownText value={result} /></div> : data.status === "RUNNING" ? <div className="empty-state" data-tone="active"><LoaderCircle size={22} data-spin="true" aria-hidden="true" /><div><h3>Result pending</h3><p>The provider has not returned its response yet.</p></div></div> : <EmptyState title="No result recorded" description="Use the timeline and error evidence above for this attempt." />}
          </section>

          <section className="panel">
            <SectionHeading title="Automated review" description="Review sessions are independent durable jobs; this evidence belongs to the review job that owns it." />
            {data.review ? <ReviewEvidence review={data.review} response={review} /> : <EmptyState title="No review recorded" description={data.jobType === "REVIEW" ? "This review job did not persist a review result." : "Reviews run as separate jobs with their own history."} />}
          </section>
        </div>

        <aside className="detail-aside" aria-label="Job facts">
          <section className="panel">
            <SectionHeading title="Execution" />
            <dl className="facts">
              <div className="fact"><dt>Job kind</dt><dd>{statusLabel(data.jobType)}</dd></div>
              <div className="fact"><dt>Subject</dt><dd>{subject}</dd></div>
              {trigger ? <div className="fact"><dt>Trigger</dt><dd>{trigger}</dd></div> : null}
              <div className="fact"><dt>Provider</dt><dd>{statusLabel(data.provider)}</dd></div>
              <div className="fact"><dt>Model</dt><dd>{data.model}</dd></div>
              <div className="fact"><dt>Reasoning</dt><dd>{data.reasoningEffort ?? "Provider default"}</dd></div>
              <div className="fact"><dt>Attempt</dt><dd>{data.attempts}</dd></div>
              <div className="fact"><dt>Exit code</dt><dd>{data.exitCode ?? "Not recorded"}</dd></div>
              <div className="fact"><dt>Duration</dt><dd>{duration(data.durationMs)}</dd></div>
              <div className="fact"><dt>Worker</dt><dd>{data.workerId ?? "Not assigned"}</dd></div>
              <div className="fact"><dt>Session</dt><dd className="mono">{data.implementationSessionId ?? "Not recorded"}</dd></div>
            </dl>
          </section>
          <section className="panel">
            <SectionHeading title="Git context" />
            <dl className="facts">
              <div className="fact"><dt>Required base</dt><dd>develop</dd></div>
              <div className="fact"><dt>Baseline</dt><dd className="mono" title={data.baselineCommit}>{shortCommit(data.baselineCommit)}</dd></div>
              <div className="fact"><dt>Branch</dt><dd className="mono">{data.branchName}</dd></div>
              <div className="fact"><dt>Pull request</dt><dd>{data.pullRequestNumber ? `#${data.pullRequestNumber}` : "Not opened"}</dd></div>
              <div className="fact"><dt>Head SHA</dt><dd className="mono" title={data.headSha ?? undefined}>{shortCommit(data.headSha)}</dd></div>
            </dl>
          </section>
          <section className="panel">
            <SectionHeading title="Lifecycle" />
            <dl className="facts">
              <div className="fact"><dt>Queued</dt><dd>{dateTime(data.queuedAt)}</dd></div>
              <div className="fact"><dt>Started</dt><dd>{dateTime(data.startedAt)}</dd></div>
              <div className="fact"><dt>Completed</dt><dd>{dateTime(data.completedAt)}</dd></div>
              <div className="fact"><dt>Heartbeat</dt><dd>{dateTime(data.heartbeatAt)}</dd></div>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}

function MarkdownText({ value, className = "rich-text" }: { value: string; className?: string }) {
  return <p className={className}>{inlineMarkdown(value).map((part, index) => {
    if (part.kind === "strong") return <strong key={index}>{part.value}</strong>;
    if (part.kind === "code") return <code className="inline-code" key={index}>{part.value}</code>;
    if (part.kind === "link" && part.href) return <a href={part.href} target="_blank" rel="noreferrer" key={index}>{part.value}</a>;
    return <span key={index}>{part.value}</span>;
  })}</p>;
}

function ReviewEvidence({ review, response }: { review: NonNullable<import("@/hooks/api").Job["review"]>; response: string | null }) {
  return (
    <div className="review-evidence">
      <div className="review-meta"><StatusPill status={review.status} /><span className="list-meta">{statusLabel(review.provider)} · {review.model} · {duration(review.durationMs)}</span></div>
      {review.errorMessage ? <div className="outcome-message" data-tone="danger"><CircleAlert size={19} aria-hidden="true" /><div><h3>Review failed</h3><MarkdownText value={review.errorMessage} /></div></div> : null}
      {response ? <div className="response-evidence"><MarkdownText value={response} /></div> : review.errorMessage ? null : <div className="empty-state" data-tone="active"><LoaderCircle size={22} data-spin="true" aria-hidden="true" /><div><h3>Review pending</h3><p>The reviewer has not returned its response yet.</p></div></div>}
    </div>
  );
}

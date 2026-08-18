"use client";

import {
  Ban,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  ActionMessage,
  EmptyState,
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
  diagnosticsBundle,
  duration,
  inlineMarkdown,
  normalizeDiagnostics,
  shortCommit,
  statusLabel,
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

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/jobs">Jobs</Link><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">{data.repository.fullName} #{data.issueNumber}</span></nav>
      <header className="page-header">
        <div className="job-heading">
          <p className="eyebrow">Job evidence</p>
          <h1>{data.issueTitle}</h1>
          <div className="job-context"><StatusPill status={data.status} /><a href={data.issueUrl} target="_blank" rel="noreferrer">{data.repository.fullName} #{data.issueNumber} <ExternalLink size={13} aria-hidden="true" /></a><span className="mono">{data.id}</span></div>
        </div>
        <div className="page-actions">
          {cancellable.has(data.status) ? <button className="button danger" type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending}><Ban size={16} aria-hidden="true" />{cancel.isPending ? "Cancelling…" : "Cancel job"}</button> : null}
          {retryable.has(data.status) ? <button className="button primary" type="button" onClick={() => retry.mutate()} disabled={retry.isPending}><RotateCcw size={16} aria-hidden="true" />{retry.isPending ? "Requesting retry…" : "Retry job"}</button> : null}
          {data.pullRequestUrl ? <a className="button secondary" href={data.pullRequestUrl} target="_blank" rel="noreferrer"><GitPullRequest size={16} aria-hidden="true" />Open PR</a> : null}
        </div>
      </header>
      <ActionMessage pending={cancel.isPending || retry.isPending} error={cancel.error || retry.error} success={cancel.isSuccess || retry.isSuccess} pendingText={cancel.isPending ? "Cancelling the job…" : "Restoring the ready label and starting a scan…"} />

      {data.errorMessage ? <div className="notice" role="alert"><CircleAlert size={20} aria-hidden="true" /><div><strong>The job requires attention</strong><p>{data.errorMessage}</p></div></div> : null}

      <div className="detail-grid">
        <div className="detail-main">
          {data.status === "FAILED" ? <section className="panel"><FailureDiagnostics diagnostics={data.diagnostics} /></section> : null}
          <section className="panel">
            <SectionHeading title="Timeline" description={data.status === "RUNNING" ? "Polling every two seconds while this job remains active." : "Only non-empty agent output, in chronological order."} />
            {events.length ? <ol className="timeline">{events.map((event) => <li className="timeline-item" data-level={event.level} key={event.id}><span className="timeline-dot" aria-hidden="true" /><div className="timeline-copy"><div className="timeline-head"><strong>Agent output</strong><time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time></div><MarkdownText value={agentOutputMessage(event.message, data.pullRequestUrl)} /></div></li>)}</ol> : <EmptyState title="No agent output recorded" description="Agent messages will appear here as the worker progresses." />}
          </section>

          <section className="panel">
            <SectionHeading title="Result" description="The agent response retained with this immutable attempt." />
            {result ? <div className="response-evidence"><MarkdownText value={result} /></div> : data.status === "RUNNING" ? <div className="empty-state" data-tone="active"><LoaderCircle size={22} data-spin="true" aria-hidden="true" /><div><h3>Result pending</h3><p>The provider has not returned its response yet.</p></div></div> : <EmptyState title="No result recorded" description="Use the timeline and error evidence above for this attempt." />}
          </section>

          <section className="panel">
            <SectionHeading title="Independent review" description="A fresh provider session evaluates the pull request against the issue and develop diff." />
            {data.review ? <ReviewEvidence review={data.review} response={review} /> : <EmptyState title="No review yet" description={data.pullRequestUrl ? "The independent review has not completed." : "A review starts only after the job opens a verified pull request."} />}
          </section>
        </div>

        <aside className="detail-aside" aria-label="Job facts">
          <section className="panel">
            <SectionHeading title="Execution" />
            <dl className="facts">
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

function FailureDiagnostics({ diagnostics }: { diagnostics: unknown }) {
  const [copied, setCopied] = useState(false);
  const view = normalizeDiagnostics(diagnostics);

  if (!view) {
    return (
      <>
        <SectionHeading title="Technical details" description="No structured execution diagnostics were captured for this failed attempt." />
        <div className="outcome-message" data-tone="danger"><CircleAlert size={19} aria-hidden="true" /><div><h3>Diagnostics unavailable</h3><MarkdownText value="This failed job predates structured diagnostics or the worker could not record evidence. The timeline and error evidence above are the only records; nothing is fabricated." /></div></div>
      </>
    );
  }

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticsBundle(view));
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // clipboard access can be blocked; leave the action silent
    }
  };

  return (
    <>
      <SectionHeading
        title="Technical details"
        description="Sanitized execution evidence for this failed attempt."
        action={<button className="button secondary" type="button" onClick={() => void copyDiagnostics()}><Copy size={16} aria-hidden="true" />{copied ? "Copied" : "Copy diagnostics"}</button>}
      />
      <dl className="facts">
        <div className="fact"><dt>Failed stage</dt><dd>{statusLabel(view.stage)}</dd></div>
        <div className="fact"><dt>Role</dt><dd>{view.role ? statusLabel(view.role) : "Not recorded"}</dd></div>
        <div className="fact"><dt>Provider</dt><dd>{statusLabel(view.provider)}</dd></div>
        <div className="fact"><dt>Model</dt><dd>{view.model}</dd></div>
        <div className="fact"><dt>Session</dt><dd className="mono">{view.sessionId ?? "Not recorded"}</dd></div>
        <div className="fact"><dt>Exit code</dt><dd>{view.exitCode ?? "Not recorded"}</dd></div>
      </dl>
      <details className="diagnostics-details">
        <summary><ChevronDown size={16} aria-hidden="true" />Show technical details</summary>
        <DiagnosticBlock title="Error" text={view.error} />
        {view.causeChain.length ? <DiagnosticBlock title="Cause chain" lines={view.causeChain} /> : null}
        <DiagnosticBlock title="Stderr" text={view.stderr} />
        <DiagnosticBlock title="Final provider output" text={view.finalOutput} />
        <div className="diagnostics-block">
          <h3>Agent/tool timeline</h3>
          {view.events.length
            ? <ol className="diagnostics-timeline">{view.events.map((event) => <li key={`${event.timestamp}:${event.type}`}><span className="diagnostics-event-time mono">{event.timestamp || "No timestamp"}</span><span><strong>{statusLabel(event.type)}</strong>{event.tool ? <span className="list-meta"> · {event.tool}</span> : null}</span>{event.message ? <MarkdownText value={event.message} /> : null}</li>)}</ol>
            : <p className="muted">No agent or tool events were recorded for this attempt.</p>}
        </div>
      </details>
    </>
  );
}

function DiagnosticBlock({ title, text, lines }: { title: string; text?: string | null; lines?: string[] }) {
  if (lines) {
    return <div className="diagnostics-block"><h3>{title}</h3><pre className="diagnostics-pre">{lines.join("\n")}</pre></div>;
  }
  return <div className="diagnostics-block"><h3>{title}</h3>{text ? <pre className="diagnostics-pre">{text}</pre> : <p className="muted">Not recorded</p>}</div>;
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

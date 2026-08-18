"use client";

import {
  Ban,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  ListChecks,
  LoaderCircle,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import {
  ActionMessage,
  EmptyState,
  PageError,
  PageSkeleton,
  SectionHeading,
  StatusPill,
} from "@/components/operational";
import { useCancelJob, useJob, useRetryJob, type Job } from "@/hooks/api";
import {
  agentOutputEvents,
  agentOutputMessage,
  dateTime,
  duration,
  inlineMarkdown,
  normalizeAgentOutput,
  normalizeJobResult,
  normalizeReview,
  shortCommit,
  statusLabel,
  type JobResultView,
  type ReviewView,
} from "@/lib/format";

const cancellable = new Set(["QUEUED", "RUNNING"]);
const retryable = new Set(["FAILED", "BLOCKED", "CANCELLED", "STALE"]);
type JobReview = NonNullable<Job["review"]>;

export default function JobPage() {
  const id = String(useParams<{ id: string }>().id);
  const job = useJob(id);
  const cancel = useCancelJob(id);
  const retry = useRetryJob(id);

  if (job.isPending) return <PageSkeleton label="Loading job evidence" />;
  if (job.error || !job.data) return <PageError error={job.error} retry={() => void job.refetch()} />;
  const data = job.data;
  const events = agentOutputEvents(data.events);
  const result = normalizeJobResult(data.result);
  const review = data.review ? normalizeReview(data.review.verdict, data.review.findings) : null;

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

      <BlockedByNotice data={data} />

      <div className="detail-grid">
        <div className="detail-main">
          <section className="panel">
            <SectionHeading title="Timeline" description={data.status === "RUNNING" ? "Polling every two seconds while this job remains active." : "Only non-empty agent output, in chronological order."} />
            {events.length ? <ol className="timeline">{events.map((event) => <li className="timeline-item" data-level={event.level} key={event.id}><span className="timeline-dot" aria-hidden="true" /><div className="timeline-copy"><div className="timeline-head"><strong>Agent output</strong><time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time></div><AgentTimelineOutput message={event.message} pullRequestUrl={data.pullRequestUrl} /></div></li>)}</ol> : <EmptyState title="No agent output recorded" description="Agent messages will appear here as the worker progresses." />}
          </section>

          <section className="panel">
            <SectionHeading title="Result" description="Structured provider output retained with this immutable attempt." action={result ? <StatusPill status={result.outcome.toUpperCase()} /> : undefined} />
            {result ? <ResultEvidence result={result} pullRequestUrl={data.pullRequestUrl} /> : data.status === "RUNNING" ? <div className="empty-state" data-tone="active"><LoaderCircle size={22} data-spin="true" aria-hidden="true" /><div><h3>Result pending</h3><p>The provider has not returned its structured outcome.</p></div></div> : <EmptyState title="No structured result" description="Use the timeline and error evidence above for this attempt." />}
          </section>

          <section className="panel">
            <SectionHeading title="Independent review" description="A fresh provider session evaluates the pull request against the issue and develop diff." />
            {data.review ? <ReviewEvidence review={data.review} normalized={review} /> : <EmptyState title="No review yet" description={data.pullRequestUrl ? "The independent review has not completed." : "A review starts only after the job opens a verified pull request."} />}
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

function BlockedByNotice({ data }: { data: Job }) {
  if (data.status !== "DEFERRED" || !data.blockedByIssueNumber || !data.blockedByIssueUrl) return null;
  return (
    <div className="notice" role="status">
      <CircleAlert size={20} aria-hidden="true" />
      <div>
        <strong>Deferred pending prerequisite</strong>
        <p>This job waits on <a className="text-link" href={data.blockedByIssueUrl} target="_blank" rel="noreferrer">{data.repository.fullName} #{data.blockedByIssueNumber}</a> — {data.blockedByIssueTitle}. {data.blockedReason}</p>
      </div>
    </div>
  );
}

function AgentTimelineOutput({ message, pullRequestUrl }: { message: string; pullRequestUrl: string | null }) {
  const output = normalizeAgentOutput(message);
  if (!output) return <MarkdownText value={agentOutputMessage(message, pullRequestUrl)} />;
  return <div className="timeline-output">{output.outcome ? <StatusPill status={output.outcome.toUpperCase()} /> : null}<MarkdownText value={agentOutputMessage(output.summary, pullRequestUrl)} /></div>;
}

function ResultEvidence({ result, pullRequestUrl }: { result: JobResultView; pullRequestUrl: string | null }) {
  return (
    <div className="structured-result">
      <div className="result-intro"><div className="result-intro-label" data-tone={result.outcome}><ResultIcon outcome={result.outcome} /><span>{statusLabel(result.outcome)}</span></div><MarkdownText value={result.summary} /></div>
      {result.outcome === "implemented" ? <ImplementedResult result={result} pullRequestUrl={pullRequestUrl} /> : null}
      {result.outcome === "blocked" ? <OutcomeMessage icon={<TriangleAlert size={19} aria-hidden="true" />} title="Information required" message={result.question} tone="warning" /> : null}
      {result.outcome === "requires_decomposition" ? <OutcomeMessage icon={<TriangleAlert size={19} aria-hidden="true" />} title="Needs decomposition" message={result.reason} tone="warning" /> : null}
      {result.outcome === "decomposed" ? <DecomposedResult result={result} /> : null}
    </div>
  );
}

function ResultIcon({ outcome }: { outcome: JobResultView["outcome"] }) {
  if (outcome === "implemented") return <CircleCheck size={18} aria-hidden="true" />;
  if (outcome === "decomposed") return <GitBranch size={18} aria-hidden="true" />;
  return <TriangleAlert size={18} aria-hidden="true" />;
}

function MarkdownText({ value, className = "rich-text" }: { value: string; className?: string }) {
  return <p className={className}>{inlineMarkdown(value).map((part, index) => {
    if (part.kind === "strong") return <strong key={index}>{part.value}</strong>;
    if (part.kind === "code") return <code className="inline-code" key={index}>{part.value}</code>;
    if (part.kind === "link" && part.href) return <a href={part.href} target="_blank" rel="noreferrer" key={index}>{part.value}</a>;
    return <span key={index}>{part.value}</span>;
  })}</p>;
}

function ImplementedResult({ result, pullRequestUrl }: { result: Extract<JobResultView, { outcome: "implemented" }>; pullRequestUrl: string | null }) {
  return (
    <>
      <dl className="result-facts">
        <div className="result-fact"><dt>Pull request</dt><dd>{pullRequestUrl ? <a className="evidence-link" href={pullRequestUrl} target="_blank" rel="noreferrer"><GitPullRequest size={15} aria-hidden="true" />PR #{result.pr.number}<ExternalLink size={13} aria-hidden="true" /></a> : `#${result.pr.number}`}</dd></div>
        <div className="result-fact"><dt>Branch</dt><dd className="mono"><GitBranch size={14} aria-hidden="true" />{result.pr.head}</dd></div>
        <div className="result-fact"><dt>Base</dt><dd className="mono">{result.pr.base}</dd></div>
        <div className="result-fact"><dt>Commit</dt><dd className="mono" title={result.commit}>{shortCommit(result.commit)}</dd></div>
      </dl>
      <div className="result-list-block"><div className="result-block-heading"><h3><ListChecks size={17} aria-hidden="true" />Checks recorded</h3><span className="list-meta">{result.tests.length}</span></div>{result.tests.length ? <ul className="result-list">{result.tests.map((test) => <li key={test}><CircleCheck size={15} aria-hidden="true" /><code>{test}</code></li>)}</ul> : <p className="muted">No checks were returned by the provider.</p>}</div>
    </>
  );
}

function DecomposedResult({ result }: { result: Extract<JobResultView, { outcome: "decomposed" }> }) {
  return <div className="result-list-block"><div className="result-block-heading"><h3>Child issues</h3><span className="list-meta">{result.childIssues.length}</span></div>{result.childIssues.length ? <ul className="result-list">{result.childIssues.map((child) => <li key={child.number}><a className="evidence-link" href={child.url} target="_blank" rel="noreferrer">Issue #{child.number}<ExternalLink size={13} aria-hidden="true" /></a><StatusPill status={child.ready ? "READY" : "PENDING"} /></li>)}</ul> : <p className="muted">No child issues were returned.</p>}</div>;
}

function OutcomeMessage({ icon, title, message, tone }: { icon: ReactNode; title: string; message: string; tone: "warning" | "danger" }) {
  return <div className="outcome-message" data-tone={tone}>{icon}<div><h3>{title}</h3><MarkdownText value={message} /></div></div>;
}

function ReviewEvidence({ review, normalized }: { review: JobReview; normalized: ReviewView | null }) {
  return (
    <div className="review-evidence">
      <div className="review-meta"><StatusPill status={review.status} /><span className="list-meta">{statusLabel(review.provider)} · {review.model} · {duration(review.durationMs)}</span></div>
      {review.errorMessage ? <div className="outcome-message" data-tone="danger"><CircleAlert size={19} aria-hidden="true" /><div><h3>Review failed</h3><MarkdownText value={review.errorMessage} /></div></div> : null}
      {normalized ? <ReviewContent review={normalized} /> : review.errorMessage ? null : <div className="empty-state" data-tone="active"><LoaderCircle size={22} data-spin="true" aria-hidden="true" /><div><h3>Review pending</h3><p>The reviewer has not returned a structured verdict yet.</p></div></div>}
    </div>
  );
}

function ReviewContent({ review }: { review: ReviewView }) {
  return (
    <div className="review-content">
      <div className="review-verdict"><div className="result-block-heading"><h3>Verdict</h3><span className="severity-pill" data-severity={review.verdict}>{statusLabel(review.verdict)}</span></div><MarkdownText value={review.summary} /></div>
      <div className="review-findings"><div className="result-block-heading"><h3>Findings</h3><span className="list-meta">{review.findings.length}</span></div>{review.findings.length ? review.findings.map((finding) => <article className="review-finding" data-severity={finding.severity} key={`${finding.file}:${finding.line ?? "file"}:${finding.problem}`}><div className="finding-meta"><span className="severity-pill" data-severity={finding.severity}>{statusLabel(finding.severity)}</span><code>{finding.file}{finding.line ? `:${finding.line}` : ""}</code></div><MarkdownText value={finding.problem} /><div className="finding-correction"><strong>Correction</strong><MarkdownText value={finding.correction} /></div></article>) : <p className="muted">No findings. The reviewer did not identify an issue in this attempt.</p>}</div>
    </div>
  );
}

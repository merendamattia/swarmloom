"use client";

import { ChevronDown, CircleAlert, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionMessage } from "@/components/ui/feedback";
import { FactList } from "@/components/ui/fact-list";
import { SectionHeading } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { useCreateSupportIssue, type Job } from "@/hooks/api";
import { diagnosticsBundle, duration, inlineMarkdown, normalizeDiagnostics, statusLabel } from "@/lib/format";

export function MarkdownText({ value, className = "rich-text" }: { value: string; className?: string }) {
  return <p className={className}>{inlineMarkdown(value).map((part, index) => {
    if (part.kind === "strong") return <strong key={index}>{part.value}</strong>;
    if (part.kind === "code") return <code className="inline-code" key={index}>{part.value}</code>;
    if (part.kind === "link" && part.href) return <a href={part.href} target="_blank" rel="noreferrer" key={index}>{part.value}</a>;
    return <span key={index}>{part.value}</span>;
  })}</p>;
}

export function FailureDiagnostics({ diagnostics, jobId, supportIssueNumber, supportIssueUrl }: {
  diagnostics: unknown;
  jobId: string;
  supportIssueNumber: number | null;
  supportIssueUrl: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const view = normalizeDiagnostics(diagnostics);
  const createSupportIssue = useCreateSupportIssue(jobId);
  const createdIssueUrl = createSupportIssue.data?.issueUrl ?? supportIssueUrl;
  const createdIssueNumber = createSupportIssue.data?.issueNumber ?? supportIssueNumber;
  const supportIssueAction = createdIssueUrl
    ? <ButtonLink href={createdIssueUrl} external><ExternalLink aria-hidden="true" />Open support issue</ButtonLink>
    : <Button variant="secondary" onClick={() => createSupportIssue.mutate()} disabled={createSupportIssue.isPending}><ExternalLink aria-hidden="true" />{createSupportIssue.isPending ? "Creating issue…" : "Open support issue"}</Button>;
  const supportIssueMessage = createSupportIssue.error
    ? <ActionMessage pending={false} error={createSupportIssue.error} success={false} pendingText="" />
    : createdIssueUrl
      ? <p className="action-message" role="status">Support issue available: <a href={createdIssueUrl} target="_blank" rel="noreferrer">{createdIssueNumber ? `#${createdIssueNumber}` : "Open issue"}</a></p>
      : null;

  if (!view) {
    return (
      <>
        <SectionHeading title="Technical details" description="No structured execution diagnostics were captured for this failed attempt." action={supportIssueAction} />
        {supportIssueMessage}
        <div className="outcome-message" data-tone="danger"><CircleAlert aria-hidden="true" /><div><h3>Diagnostics unavailable</h3><MarkdownText value="This failed job predates structured diagnostics or the worker could not record evidence. The timeline and error evidence above are the only records; nothing is fabricated." /></div></div>
      </>
    );
  }

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticsBundle(view));
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <SectionHeading
        title="Technical details"
        description="Sanitized execution evidence for this failed attempt."
        action={<div className="page-actions">{supportIssueAction}<Button variant="secondary" onClick={() => void copyDiagnostics()}><Copy aria-hidden="true" />{copied ? "Copied" : "Copy diagnostics"}</Button></div>}
      />
      {supportIssueMessage}
      <FactList items={[
        { label: "Failed stage", value: statusLabel(view.stage) },
        { label: "Role", value: view.role ? statusLabel(view.role) : "Not recorded" },
        { label: "Provider", value: statusLabel(view.provider) },
        { label: "Model", value: view.model },
        { label: "Session", value: view.sessionId ?? "Not recorded", mono: true },
        { label: "Exit code", value: view.exitCode ?? "Not recorded" },
      ]} />
      <details className="diagnostics-details">
        <summary><ChevronDown aria-hidden="true" />Show technical details</summary>
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
  if (lines) return <div className="diagnostics-block"><h3>{title}</h3><pre className="diagnostics-pre">{lines.join("\n")}</pre></div>;
  return <div className="diagnostics-block"><h3>{title}</h3>{text ? <pre className="diagnostics-pre">{text}</pre> : <p className="muted">Not recorded</p>}</div>;
}

export function ReviewEvidence({ review, response }: { review: NonNullable<Job["review"]>; response: string | null }) {
  return (
    <div className="review-evidence">
      <div className="review-meta"><StatusPill status={review.status} /><span className="list-meta">{statusLabel(review.provider)} · {review.model} · {duration(review.durationMs)}</span></div>
      {review.errorMessage ? <div className="outcome-message" data-tone="danger"><CircleAlert aria-hidden="true" /><div><h3>Review failed</h3><MarkdownText value={review.errorMessage} /></div></div> : null}
      {response
        ? <div className="response-evidence"><MarkdownText value={response} /></div>
        : review.errorMessage
          ? null
          : <EmptyState tone="active" title="Review pending" description="The reviewer has not returned its response yet." />}
    </div>
  );
}

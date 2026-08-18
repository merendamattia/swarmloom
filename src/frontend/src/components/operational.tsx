"use client";

import type { LucideIcon } from "lucide-react";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Clock3,
  GitPullRequest,
  LoaderCircle,
  Split,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import type { Jobs } from "@/hooks/api";
import { dateTime, duration, statusLabel } from "@/lib/format";

type Tone = "neutral" | "active" | "success" | "warning" | "danger";
const states: Record<string, { tone: Tone; icon: LucideIcon }> = {
  QUEUED: { tone: "neutral", icon: Clock3 },
  RUNNING: { tone: "active", icon: LoaderCircle },
  COMPLETED: { tone: "success", icon: CircleCheck },
  IMPLEMENTED: { tone: "success", icon: CircleCheck },
  PASSED: { tone: "success", icon: CircleCheck },
  READY: { tone: "success", icon: CircleCheck },
  FAILED: { tone: "danger", icon: CircleX },
  ERROR: { tone: "danger", icon: CircleX },
  INVALID: { tone: "danger", icon: CircleX },
  STALE: { tone: "danger", icon: CircleAlert },
  BLOCKED: { tone: "warning", icon: TriangleAlert },
  DEFERRED: { tone: "warning", icon: TriangleAlert },
  CHANGES_REQUESTED: { tone: "warning", icon: TriangleAlert },
  DECOMPOSED: { tone: "neutral", icon: Split },
  REQUIRES_DECOMPOSITION: { tone: "warning", icon: TriangleAlert },
  CANCELLED: { tone: "neutral", icon: Ban },
  PENDING: { tone: "neutral", icon: CircleDashed },
  SKIPPED: { tone: "neutral", icon: CircleDashed },
};

export function StatusPill({ status }: { status: string }) {
  const state = states[status] ?? { tone: "neutral" as const, icon: CircleDot };
  const Icon = state.icon;
  return <span className="status-pill" data-tone={state.tone}><Icon size={13} aria-hidden="true" />{statusLabel(status)}</span>;
}

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function SectionHeading({ id, title, description, action }: {
  id?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-heading">
      <div><h2 id={id}>{title}</h2>{description ? <p>{description}</p> : null}</div>
      {action}
    </div>
  );
}

export function PageSkeleton({ label = "Loading operational data" }: { label?: string }) {
  return (
    <div className="skeleton-page" role="status" aria-label={label}>
      <span className="sr-only">{label}…</span>
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-strip" />
      <div className="skeleton-grid"><div className="skeleton skeleton-panel" /><div className="skeleton skeleton-panel" /></div>
    </div>
  );
}

export function PageError({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : "The request failed.";
  return (
    <section className="state-panel state-error" role="alert">
      <CircleAlert size={22} aria-hidden="true" />
      <div><h2>Operational data is unavailable</h2><p>We could not reach the worker API: {message}</p></div>
      {retry ? <button className="button secondary" type="button" onClick={retry}>Try again</button> : null}
    </section>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <CircleCheck size={22} aria-hidden="true" />
      <div><h3>{title}</h3><p>{description}</p></div>
      {action}
    </div>
  );
}

export function ActionMessage({ pending, error, success, pendingText, successText, variant }: {
  pending: boolean;
  error: unknown;
  success: boolean;
  pendingText: string;
  successText?: string;
  variant?: "inline" | "toast";
}) {
  const text = pending ? pendingText : error instanceof Error ? error.message : success ? successText ?? "The API confirmed the action." : "";
  if (!text) return null;
  return <p className={`action-message action-message-${variant ?? "inline"}`} data-error={Boolean(error)} data-pending={pending} role={error ? "alert" : "status"} aria-live="polite">{text}</p>;
}

type JobSummary = Jobs["items"][number];

export function JobTable({ jobs, compact = false }: { jobs: JobSummary[]; compact?: boolean }) {
  if (jobs.length === 0) return <EmptyState title="No jobs found" description="Run a scan or adjust the filters to find durable job history." />;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>Status</th><th>Issue</th><th>Repository</th><th>Provider</th>{compact ? null : <th>Duration</th>}<th>Created</th><th><span className="sr-only">Details</span></th></tr></thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td data-label="Status"><StatusPill status={job.status} /></td>
              <td data-label="Issue"><Link className="row-title" href={`/jobs/${job.id}`}>#{job.issueNumber} {job.issueTitle}</Link>{job.pullRequestUrl ? <a className="inline-meta" href={job.pullRequestUrl} target="_blank" rel="noreferrer"><GitPullRequest size={13} aria-hidden="true" />PR {job.pullRequestNumber}</a> : null}</td>
              <td data-label="Repository">{job.repository.fullName}</td>
              <td data-label="Provider">{statusLabel(job.provider)} · {job.model}</td>
              {compact ? null : <td data-label="Duration" className="numeric">{duration(job.durationMs)}</td>}
              <td data-label="Created" className="numeric">{dateTime(job.createdAt)}</td>
              <td data-label="Details"><Link className="text-link" href={`/jobs/${job.id}`} aria-label={`Open job ${job.repository.fullName} issue ${job.issueNumber}`}>Inspect</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

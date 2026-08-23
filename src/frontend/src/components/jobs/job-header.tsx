import { Ban, ExternalLink, GitPullRequest, RotateCcw } from "lucide-react";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Button, ButtonLink } from "@/components/ui/button";
import { JobKindPill, StatusPill } from "@/components/ui/status-pill";
import type { Job } from "@/hooks/api";

const cancellable = new Set(["QUEUED", "RUNNING"]);
const retryable = new Set(["FAILED", "BLOCKED", "CANCELLED", "STALE"]);

export function JobHeader({ job, subject, cancelling, retrying, onCancel, onRetry }: {
  job: Job;
  subject: string;
  cancelling: boolean;
  retrying: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  return (
    <>
      <Breadcrumbs items={[{ href: "/jobs", label: "Jobs" }]} current={`${job.repository.fullName} ${subject}`} />
      <header className="page-header">
        <div className="job-heading">
          <p className="eyebrow">Job evidence</p>
          <h1>{job.issueTitle}</h1>
          <div className="job-context"><StatusPill status={job.status} /><JobKindPill jobType={job.jobType} /><a href={job.issueUrl} target="_blank" rel="noreferrer">{subject} · issue #{job.issueNumber} <ExternalLink aria-hidden="true" /></a><span className="mono">{job.id}</span></div>
        </div>
        <div className="page-actions">
          {cancellable.has(job.status) ? <Button variant="danger" onClick={onCancel} disabled={cancelling}><Ban aria-hidden="true" />{cancelling ? "Cancelling…" : "Cancel job"}</Button> : null}
          {retryable.has(job.status) ? <Button variant="primary" onClick={onRetry} disabled={retrying}><RotateCcw aria-hidden="true" />{retrying ? "Requesting retry…" : "Retry job"}</Button> : null}
          {job.pullRequestUrl ? <ButtonLink href={job.pullRequestUrl} external><GitPullRequest aria-hidden="true" />Open PR</ButtonLink> : null}
        </div>
      </header>
    </>
  );
}

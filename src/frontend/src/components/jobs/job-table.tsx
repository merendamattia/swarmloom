"use client";

import { GitPullRequest } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { JobKindPill, StatusPill } from "@/components/ui/status-pill";
import { TextLink } from "@/components/ui/text-link";
import type { Jobs } from "@/hooks/api";
import { dateTime, duration, shortCommit, statusLabel, subjectLabel, triggerLabel } from "@/lib/format";

type JobSummary = Jobs["items"][number];

export function JobTable({ jobs, compact = false }: { jobs: JobSummary[]; compact?: boolean }) {
  if (jobs.length === 0) return <EmptyState title="No jobs found" description="Run a scan or adjust the filters to find durable job history." />;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>Status</th><th>Subject</th><th>Repository</th><th>Provider</th>{compact ? null : <th>Duration</th>}<th>Created</th><th><span className="sr-only">Details</span></th></tr></thead>
        <tbody>
          {jobs.map((job) => {
            const trigger = triggerLabel(job.trigger);
            return (
              <tr key={job.id}>
                <td data-label="Status"><StatusPill status={job.status} /></td>
                <td data-label="Subject">
                  <JobKindPill jobType={job.jobType} />
                  <Link className="row-title" href={`/jobs/${job.id}`}>{subjectLabel(job.subjectType, job.issueNumber, job.pullRequestNumber)} {job.issueTitle}</Link>
                  {job.pullRequestUrl ? <a className="inline-meta" href={job.pullRequestUrl} target="_blank" rel="noreferrer"><GitPullRequest aria-hidden="true" />PR {job.pullRequestNumber}</a> : null}
                  <p className="list-meta">{job.headSha ? `head ${shortCommit(job.headSha)} · ` : ""}{trigger ?? ""}{job.review?.status && job.jobType === "REVIEW" ? `${trigger ? " · " : ""}${statusLabel(job.review.status)}` : ""}</p>
                </td>
                <td data-label="Repository">{job.repository.fullName}</td>
                <td data-label="Provider">{statusLabel(job.provider)} · {job.model}</td>
                {compact ? null : <td data-label="Duration" className="numeric">{duration(job.durationMs)}</td>}
                <td data-label="Created" className="numeric">{dateTime(job.createdAt)}</td>
                <td data-label="Details"><TextLink href={`/jobs/${job.id}`} aria-label={`Open job ${job.repository.fullName} ${subjectLabel(job.subjectType, job.issueNumber, job.pullRequestNumber)}`}>Inspect</TextLink></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

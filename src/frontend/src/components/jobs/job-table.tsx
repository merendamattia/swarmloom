import { GitPullRequest } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { JobKindPill, StatusPill } from "@/components/ui/status-pill";
import type { Jobs } from "@/hooks/api";
import { activeDuration, dateTime, quotaWaitDuration, shortCommit, statusLabel, subjectLabel, triggerLabel } from "@/lib/format";

type JobSummary = Jobs["items"][number];

export function JobTable({ jobs, compact = false }: { jobs: JobSummary[]; compact?: boolean }) {
  if (jobs.length === 0) return <EmptyState title="No jobs found" description="Run a scan or adjust the filters to find durable job history." />;
  return (
    <div className="table-wrap">
      <table className="data-table" data-compact={compact || undefined}>
        <caption className="sr-only">{compact ? "Five most recent jobs" : "Complete job history"}</caption>
        <thead><tr><th className="job-status-heading">Status</th><th className="job-main-heading">Job</th><th>Repository</th><th>Agent</th><th>{compact ? "Started" : "Timing"}</th></tr></thead>
        <tbody>
          {jobs.map((job) => {
            const trigger = triggerLabel(job.trigger);
            const hasQuotaWait = job.status === "WAITING_FOR_QUOTA" || job.quotaWaitDurationMs > 0 || Boolean(job.quotaWaitStartedAt);
            const context = [
              job.headSha ? `head ${shortCommit(job.headSha)}` : null,
              trigger,
              job.review?.status && job.jobType === "REVIEW" ? statusLabel(job.review.status) : null,
            ].filter(Boolean).join(" · ");
            return (
              <tr key={job.id}>
                <td className="job-status-cell" data-label="Status"><StatusPill status={job.status} /></td>
                <td className="job-main-cell" data-label="Job">
                  <div className="job-meta-line">
                    <JobKindPill jobType={job.jobType} />
                    <span>{subjectLabel(job.subjectType, job.issueNumber, job.pullRequestNumber)}</span>
                    {context ? <span>{context}</span> : null}
                  </div>
                  <div className="job-title-line">
                    <Link className="job-title" href={`/jobs/${job.id}`}>{job.issueTitle}</Link>
                    {job.pullRequestUrl ? <a className="job-pr-link" href={job.pullRequestUrl} target="_blank" rel="noreferrer" aria-label={`Open pull request ${job.pullRequestNumber}`}><GitPullRequest aria-hidden="true" />PR {job.pullRequestNumber}</a> : null}
                  </div>
                </td>
                <td data-label="Repository"><span className="job-repository">{job.repository.fullName}</span></td>
                <td data-label="Agent"><span className="job-agent"><strong>{statusLabel(job.provider)}</strong><span>{job.model}</span><span>{job.reasoningEffort ? `${statusLabel(job.reasoningEffort)} reasoning` : "Provider default"}</span></span></td>
                <td data-label={compact ? "Started" : "Timing"} className="numeric"><span className="job-timing"><time dateTime={job.createdAt}>{dateTime(job.createdAt)}</time>{compact ? null : hasQuotaWait ? <span>{activeDuration(job.activeDurationMs, job.activeStartedAt)} active · {quotaWaitDuration(job.quotaWaitDurationMs, job.quotaWaitStartedAt)} quota wait</span> : <span>{activeDuration(job.activeDurationMs, job.activeStartedAt)}</span>}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

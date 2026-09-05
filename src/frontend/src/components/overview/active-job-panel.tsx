import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FactList } from "@/components/ui/fact-list";
import { SectionHeading } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import type { Dashboard } from "@/hooks/api";
import { dateTime, shortCommit, statusLabel } from "@/lib/format";

type ActiveJob = Dashboard["activeJobs"][number];

export function ActiveJobPanel({ job, queued }: { job?: ActiveJob; queued: number }) {
  return (
    <Panel as="aside" aria-labelledby="active-title">
      <SectionHeading id="active-title" title="Active job" description="Running work and quota waits reconcile automatically." />
      {job ? (
        <div className="active-job">
          <StatusPill status={job.status} />
          <Link className="active-job-title" href={`/jobs/${job.id}`}>{job.repository.fullName} #{job.issueNumber}<br />{job.issueTitle}</Link>
          <div className="progress-rule" aria-hidden="true" />
          <FactList items={[
            { label: job.status === "WAITING_FOR_QUOTA" ? "Waiting since" : "Started", value: dateTime(job.status === "WAITING_FOR_QUOTA" ? job.quotaWaitStartedAt : job.startedAt) },
            ...(job.status === "WAITING_FOR_QUOTA" && job.quotaResetAt ? [{ label: "Quota reset", value: dateTime(job.quotaResetAt) }] : []),
            { label: "Provider", value: statusLabel(job.provider) },
            { label: "Baseline", value: shortCommit(job.baselineCommit), mono: true },
            { label: "Attempt", value: job.attempts },
          ]} />
          <ButtonLink href={`/jobs/${job.id}`}>Open live timeline</ButtonLink>
        </div>
      ) : <EmptyState title="No job is active" description={`${queued} queued. The next scan follows the configured schedule.`} />}
    </Panel>
  );
}

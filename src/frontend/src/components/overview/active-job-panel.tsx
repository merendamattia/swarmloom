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
      <SectionHeading id="active-title" title="Active job" description="Live details poll only while work is running." />
      {job ? (
        <div className="active-job">
          <StatusPill status={job.status} />
          <Link className="active-job-title" href={`/jobs/${job.id}`}>{job.repository.fullName} #{job.issueNumber}<br />{job.issueTitle}</Link>
          <div className="progress-rule" aria-hidden="true" />
          <FactList items={[
            { label: "Started", value: dateTime(job.startedAt) },
            { label: "Provider", value: statusLabel(job.provider) },
            { label: "Baseline", value: shortCommit(job.baselineCommit), mono: true },
            { label: "Attempt", value: job.attempts },
          ]} />
          <ButtonLink href={`/jobs/${job.id}`}>Open live timeline</ButtonLink>
        </div>
      ) : <EmptyState title="No job is running" description={`${queued} queued. The next scan follows the configured schedule.`} />}
    </Panel>
  );
}

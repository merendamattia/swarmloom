import { JobTable } from "@/components/jobs/job-table";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeading } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import { TextLink } from "@/components/ui/text-link";
import type { Dashboard } from "@/hooks/api";
import { dateTime, duration, shortCommit, statusLabel } from "@/lib/format";

export function RecentJobsSection({ jobs }: { jobs: Dashboard["recentJobs"] }) {
  return <section aria-labelledby="recent-title"><SectionHeading id="recent-title" title="Recent jobs" description="The latest durable outcomes across configured repositories." action={<TextLink href="/jobs">View full history</TextLink>} /><JobTable jobs={jobs} compact /></section>;
}

export function OverviewHistory({ repositories, scans }: { repositories: Dashboard["repositories"]; scans: Dashboard["scans"] }) {
  return (
    <div className="summary-grid">
      <Panel>
        <SectionHeading title="Repositories" description={`${repositories.length} configured · required branch develop`} action={<TextLink href="/repositories">Inspect all</TextLink>} />
        <ul className="plain-list">{repositories.map((repository) => <li key={repository.id}><div className="list-line"><strong>{repository.fullName}</strong><StatusPill status={repository.status} /></div><p className="list-meta">Baseline <span className="mono">{shortCommit(repository.baselineCommit)}</span> · scanned {dateTime(repository.lastScannedAt)}</p></li>)}</ul>
      </Panel>
      <Panel>
        <SectionHeading title="Recent scans" description="Scheduled and manual discovery use the same durable path." />
        {scans.length ? <ul className="plain-list">{scans.slice(0, 5).map((scan) => <li key={scan.id}><div className="list-line"><strong>{statusLabel(scan.source)} scan</strong><StatusPill status={scan.status} /></div><p className="list-meta">{dateTime(scan.startedAt)} · {scan.queuedCount} queued · {duration(scan.durationMs)}</p></li>)}</ul> : <EmptyState title="No scans recorded" description="Run a manual scan to create the first durable scan record." />}
      </Panel>
    </div>
  );
}

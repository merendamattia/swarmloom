"use client";

import { Activity, CircleAlert, CircleCheck, Play } from "lucide-react";
import Link from "next/link";
import {
  ActionMessage,
  EmptyState,
  JobTable,
  PageError,
  PageHeader,
  PageSkeleton,
  SectionHeading,
  StatusPill,
} from "@/components/operational";
import { useDashboard, useHealth, useRunScan, useStatus } from "@/hooks/api";
import { dateTime, duration, shortCommit, statusLabel } from "@/lib/format";

const exceptionStatuses = new Set(["FAILED", "BLOCKED", "STALE"]);
const serviceStateLabel: Record<string, string> = { healthy: "Healthy", offline: "Offline", unavailable: "Unavailable" };

export default function OverviewPage() {
  const dashboard = useDashboard();
  const health = useHealth();
  const status = useStatus();
  const runScan = useRunScan();
  const pending = dashboard.isPending || health.isPending || status.isPending;
  const error = dashboard.error || health.error || status.error;

  if (pending) return <PageSkeleton />;
  if (error || !dashboard.data || !health.data || !status.data) {
    return <PageError error={error} retry={() => void Promise.all([dashboard.refetch(), health.refetch(), status.refetch()])} />;
  }

  const invalidRepositories = dashboard.data.repositories.filter((repository) => repository.status === "INVALID" || repository.status === "ERROR");
  const exceptionJobs = dashboard.data.recentJobs.filter((job) => exceptionStatuses.has(job.status));
  const needsAttention = health.data.services.worker.state !== "healthy" || invalidRepositories.length > 0 || exceptionJobs.length > 0;
  const activeJob = dashboard.data.activeJobs[0];
  const providerVersion = "providerVersion" in status.data ? String(status.data.providerVersion) : "Available";
  const jobCount = Object.values(dashboard.data.jobs).reduce((sum, count) => sum + count, 0);
  const queued = dashboard.data.jobs.QUEUED ?? 0;
  const running = dashboard.data.jobs.RUNNING ?? 0;
  const infrastructure = [
    { name: "API", ...health.data.services.api },
    { name: "Worker", ...health.data.services.worker },
    { name: "Database", ...health.data.services.database },
    { name: "Queue", ...health.data.services.queue },
    { name: "Scheduler", ...health.data.services.scheduler },
  ];
  const providerState = status.data.providerAuth.status === "authenticated"
    ? { state: "healthy", detail: "Provider authenticated" }
    : { state: "unavailable", detail: "Provider login required" };
  const telegramState = !status.data.telegram.configured
    ? { state: "unavailable", detail: "Disabled" }
    : status.data.telegram.operational
      ? { state: "healthy", detail: "Delivery confirmed" }
      : { state: "unavailable", detail: "Configured, not yet confirmed" };
  const services = [
    ...infrastructure,
    { name: "Provider", ...providerState },
    { name: "Telegram", ...telegramState },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Overview"
        description="Current health, exceptions, and durable worker activity."
        actions={<button className="button primary" type="button" onClick={() => runScan.mutate()} disabled={runScan.isPending}><Play size={16} aria-hidden="true" />{runScan.isPending ? "Starting scan…" : "Run now"}</button>}
      />
      <ActionMessage pending={runScan.isPending} error={runScan.error} success={runScan.isSuccess} pendingText="Starting a manual scan…" />

      <section className="health-strip" data-health={needsAttention ? "attention" : "healthy"} aria-labelledby="health-title">
        <div className="health-summary">
          <span className="health-icon" aria-hidden="true">{needsAttention ? <CircleAlert size={23} /> : <CircleCheck size={23} />}</span>
          <div className="health-copy">
            <p className="eyebrow">System health</p>
            <h2 id="health-title">{needsAttention ? "Intervention is required" : "Operating normally"}</h2>
            <p>{needsAttention ? "Review the offline services and exceptions below before the next scheduled run." : "All services report healthy and no exception currently requires action."}</p>
          </div>
        </div>
        <dl className="health-facts">
          <div className="health-fact health-fact-wide"><dt>Services</dt><dd>
            <ul className="service-states">
              {services.map((service) => <li key={service.name} className="service-state" data-state={service.state} aria-label={`${service.name}: ${serviceStateLabel[service.state]}. ${service.detail}`}>{service.name}<span className="service-state-label">{serviceStateLabel[service.state]}</span></li>)}
            </ul>
          </dd></div>
          <div className="health-fact"><dt>Provider</dt><dd>{statusLabel(status.data.provider)} · {status.data.model}</dd></div>
          <div className="health-fact"><dt>Runtime</dt><dd>{providerVersion}</dd></div>
          <div className="health-fact"><dt>Version</dt><dd className="mono">{status.data.version}</dd></div>
          <div className="health-fact"><dt>Schedule</dt><dd><span className="mono">{status.data.schedule.cron}</span> · {status.data.schedule.timezone}</dd></div>
          <div className="health-fact"><dt>Workload</dt><dd>{jobCount} total · {queued} queued · {running} running</dd></div>
        </dl>
      </section>

      <div className="overview-grid">
        <section className="panel" aria-labelledby="exceptions-title">
          <SectionHeading id="exceptions-title" title="Exceptions" description="Only states that may need operator intervention." />
          {invalidRepositories.length === 0 && exceptionJobs.length === 0 && health.data.services.worker.state === "healthy" ? (
            <EmptyState title="No exceptions" description="Repositories are valid and recent jobs have no failed, blocked, or stale state." />
          ) : (
            <ul className="exception-list">
              {health.data.services.worker.state !== "healthy" ? <li className="exception-row"><span className="exception-icon"><Activity size={16} aria-hidden="true" /></span><div className="exception-copy"><strong>Worker heartbeat is unavailable</strong><p>The API has not received a recent worker heartbeat. Inspect the worker process and container logs.</p></div></li> : null}
              {invalidRepositories.map((repository) => <li className="exception-row" key={repository.id}><span className="exception-icon"><CircleAlert size={16} aria-hidden="true" /></span><div className="exception-copy"><strong>{repository.fullName}</strong><p>{repository.errorMessage ?? "The required origin/develop branch is unavailable."}</p><div className="exception-meta"><StatusPill status={repository.status} /><Link className="text-link" href="/repositories">Inspect repository</Link></div></div></li>)}
              {exceptionJobs.map((job) => <li className="exception-row" key={job.id}><span className="exception-icon"><CircleAlert size={16} aria-hidden="true" /></span><div className="exception-copy"><strong>{job.repository.fullName} #{job.issueNumber}: {job.issueTitle}</strong><p>{job.errorMessage ?? `The job ended as ${statusLabel(job.status).toLowerCase()}. Open the timeline for durable evidence.`}</p><div className="exception-meta"><StatusPill status={job.status} /><span className="list-meta">{dateTime(job.completedAt ?? job.updatedAt)}</span><Link className="text-link" href={`/jobs/${job.id}`}>Inspect job</Link></div></div></li>)}
            </ul>
          )}
        </section>

        <aside className="panel" aria-labelledby="active-title">
          <SectionHeading id="active-title" title="Active job" description="Live details poll only while work is running." />
          {activeJob ? (
            <div className="active-job">
              <StatusPill status={activeJob.status} />
              <Link className="active-job-title" href={`/jobs/${activeJob.id}`}>{activeJob.repository.fullName} #{activeJob.issueNumber}<br />{activeJob.issueTitle}</Link>
              <div className="progress-rule" aria-hidden="true" />
              <dl className="facts">
                <div className="fact"><dt>Started</dt><dd>{dateTime(activeJob.startedAt)}</dd></div>
                <div className="fact"><dt>Provider</dt><dd>{statusLabel(activeJob.provider)}</dd></div>
                <div className="fact"><dt>Baseline</dt><dd className="mono">{shortCommit(activeJob.baselineCommit)}</dd></div>
                <div className="fact"><dt>Attempt</dt><dd>{activeJob.attempts}</dd></div>
              </dl>
              <Link className="button secondary" href={`/jobs/${activeJob.id}`}>Open live timeline</Link>
            </div>
          ) : <EmptyState title="No job is running" description={`${queued} queued. The next scan follows the configured schedule.`} />}
        </aside>
      </div>

      <section aria-labelledby="recent-title">
        <SectionHeading id="recent-title" title="Recent jobs" description="The latest durable outcomes across configured repositories." action={<Link className="text-link" href="/jobs">View full history</Link>} />
        <JobTable jobs={dashboard.data.recentJobs} compact />
      </section>

      <div className="summary-grid">
        <section className="panel">
          <SectionHeading title="Repositories" description={`${dashboard.data.repositories.length} configured · required branch develop`} action={<Link className="text-link" href="/repositories">Inspect all</Link>} />
          <ul className="plain-list">
            {dashboard.data.repositories.map((repository) => <li key={repository.id}><div className="list-line"><strong>{repository.fullName}</strong><StatusPill status={repository.status} /></div><p className="list-meta">Baseline <span className="mono">{shortCommit(repository.baselineCommit)}</span> · scanned {dateTime(repository.lastScannedAt)}</p></li>)}
          </ul>
        </section>
        <section className="panel">
          <SectionHeading title="Recent scans" description="Scheduled and manual discovery use the same durable path." />
          {dashboard.data.scans.length ? <ul className="plain-list">{dashboard.data.scans.slice(0, 5).map((scan) => <li key={scan.id}><div className="list-line"><strong>{statusLabel(scan.source)} scan</strong><StatusPill status={scan.status} /></div><p className="list-meta">{dateTime(scan.startedAt)} · {scan.queuedCount} queued · {duration(scan.durationMs)}</p></li>)}</ul> : <EmptyState title="No scans recorded" description="Run a manual scan to create the first durable scan record." />}
        </section>
      </div>
    </>
  );
}

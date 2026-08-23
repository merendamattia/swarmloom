import { Activity, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeading } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import { TextLink } from "@/components/ui/text-link";
import type { Dashboard, Health } from "@/hooks/api";
import { dateTime, statusLabel } from "@/lib/format";

export function ExceptionsPanel({ worker, repositories, jobs, clearing, onClear }: {
  worker: Health["services"]["worker"];
  repositories: Dashboard["repositories"];
  jobs: Dashboard["exceptionJobs"];
  clearing: boolean;
  onClear: () => void;
}) {
  const empty = repositories.length === 0 && jobs.length === 0 && worker.state === "healthy";
  return (
    <Panel aria-labelledby="exceptions-title">
      <SectionHeading
        id="exceptions-title"
        title="Exceptions"
        description="Only states that may need operator intervention."
        action={jobs.length > 0 ? <Button variant="secondary" onClick={onClear} disabled={clearing}>{clearing ? "Clearing…" : "Clear resolved"}</Button> : undefined}
      />
      {empty ? <EmptyState title="No exceptions" description="Repositories are valid and recent jobs have no failed, blocked, or stale state." /> : (
        <ul className="exception-list">
          {worker.state !== "healthy" ? <li className="exception-row"><span className="exception-icon"><Activity size={16} aria-hidden="true" /></span><div className="exception-copy"><strong>Worker heartbeat is unavailable</strong><p>The API has not received a recent worker heartbeat. Inspect the worker process and container logs.</p></div></li> : null}
          {repositories.map((repository) => <li className="exception-row" key={repository.id}><span className="exception-icon"><CircleAlert size={16} aria-hidden="true" /></span><div className="exception-copy"><strong>{repository.fullName}</strong><p>{repository.errorMessage ?? "The required origin/develop branch is unavailable."}</p><div className="exception-meta"><StatusPill status={repository.status} /><TextLink href="/repositories">Inspect repository</TextLink></div></div></li>)}
          {jobs.map((job) => <li className="exception-row" key={job.id}><span className="exception-icon"><CircleAlert size={16} aria-hidden="true" /></span><div className="exception-copy"><strong>{job.repository.fullName} #{job.issueNumber}: {job.issueTitle}</strong><p>{job.errorMessage ?? `The job ended as ${statusLabel(job.status).toLowerCase()}. Open the timeline for durable evidence.`}</p><div className="exception-meta"><StatusPill status={job.status} /><span className="list-meta">{dateTime(job.completedAt ?? job.updatedAt)}</span><TextLink href={`/jobs/${job.id}`}>Inspect job</TextLink></div></div></li>)}
        </ul>
      )}
    </Panel>
  );
}

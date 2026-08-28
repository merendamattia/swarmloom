import { JobTable } from "@/components/jobs/job-table";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeading } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import type { JobFilters, Jobs } from "@/hooks/api";

export function JobHistory({ jobs, filters, fetching, onPage }: {
  jobs: Jobs;
  filters: JobFilters;
  fetching: boolean;
  onPage: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(jobs.total / jobs.pageSize));
  return (
    <Panel aria-busy={fetching}>
      <SectionHeading title="Job history" description={`${jobs.total} ${jobs.total === 1 ? "job" : "jobs"} found${fetching ? " · refreshing" : ""}.`} />
      {jobs.items.length ? <JobTable jobs={jobs.items} /> : <EmptyState title="No jobs match these filters" description="Clear one or more filters, or run a scan to discover new work." />}
      {totalPages > 1 ? <nav className="pagination" aria-label="Job history pagination">
          <Button variant="secondary" disabled={filters.page <= 1} onClick={() => onPage(filters.page - 1)}>Previous page</Button>
          <span className="list-meta">Page {jobs.page} of {totalPages}</span>
          <Button variant="secondary" disabled={filters.page >= totalPages} onClick={() => onPage(filters.page + 1)}>Next page</Button>
        </nav> : null}
    </Panel>
  );
}

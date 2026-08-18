"use client";

import { FilterX, Search } from "lucide-react";
import { type FormEvent, useState } from "react";
import { JobTable, PageError, PageHeader, PageSkeleton, SectionHeading } from "@/components/operational";
import { type JobFilters, useJobs, useRepositories } from "@/hooks/api";

const initialFilters: JobFilters = { page: 1, pageSize: 25 };
const statuses = ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "BLOCKED", "DEFERRED", "DECOMPOSED", "CANCELLED", "STALE"];

export default function JobsPage() {
  const [filters, setFilters] = useState<JobFilters>(initialFilters);
  const [query, setQuery] = useState("");
  const jobs = useJobs(filters);
  const repositories = useRepositories();

  if (jobs.isPending && !jobs.data) return <PageSkeleton label="Loading job history" />;
  if (jobs.error || !jobs.data) return <PageError error={jobs.error} retry={() => void jobs.refetch()} />;

  const totalPages = Math.max(1, Math.ceil(jobs.data.total / jobs.data.pageSize));
  const update = (next: Partial<JobFilters>) => setFilters((current) => ({ ...current, ...next, page: next.page ?? 1 }));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = query.trim();
    update({ q: q || undefined });
  };

  return (
    <>
      <PageHeader eyebrow="Durable history" title="Jobs" description="Search and filter every worker attempt without losing prior outcomes." />
      <form className="filters" onSubmit={submit} role="search">
        <div className="filter-grid">
          <div className="field"><label htmlFor="job-search">Issue, number, or repository</label><input className="input" id="job-search" name="q" type="search" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100} placeholder="Search job history" /></div>
          <div className="field"><label htmlFor="job-status">Status</label><select className="select" id="job-status" value={filters.status ?? ""} onChange={(event) => update({ status: event.target.value || undefined })}><option value="">All statuses</option>{statuses.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></div>
          <div className="field"><label htmlFor="job-provider">Provider</label><select className="select" id="job-provider" value={filters.provider ?? ""} onChange={(event) => update({ provider: event.target.value || undefined })}><option value="">All providers</option><option value="CODEX">Codex</option><option value="OPENCODE">OpenCode</option></select></div>
          <div className="field"><label htmlFor="job-repository">Repository</label><select className="select" id="job-repository" value={filters.repositoryId ?? ""} onChange={(event) => update({ repositoryId: event.target.value || undefined })}><option value="">All repositories</option>{repositories.data?.map((repository) => <option key={repository.id} value={repository.id}>{repository.fullName}</option>)}</select></div>
        </div>
        <div className="filter-actions"><button className="button primary" type="submit"><Search size={16} aria-hidden="true" />Search history</button><button className="button secondary" type="button" onClick={() => { setQuery(""); setFilters(initialFilters); }}><FilterX size={16} aria-hidden="true" />Clear filters</button></div>
      </form>

      <section className="panel" aria-busy={jobs.isFetching}>
        <SectionHeading title="Job history" description={`${jobs.data.total} ${jobs.data.total === 1 ? "job" : "jobs"} found${jobs.isFetching ? " · refreshing" : ""}.`} />
        <JobTable jobs={jobs.data.items} />
        <nav className="pagination" aria-label="Job history pagination">
          <button className="button secondary" type="button" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 })}>Previous page</button>
          <span className="list-meta">Page {jobs.data.page} of {totalPages}</span>
          <button className="button secondary" type="button" disabled={filters.page >= totalPages} onClick={() => update({ page: filters.page + 1 })}>Next page</button>
        </nav>
      </section>
    </>
  );
}

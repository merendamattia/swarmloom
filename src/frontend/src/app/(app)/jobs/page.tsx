"use client";

import { useState } from "react";
import { JobFilters } from "@/components/jobs/job-filters";
import { JobHistory } from "@/components/jobs/job-history";
import { PageError } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { type JobFilters as Filters, useJobs, useRepositories } from "@/hooks/api";

const initialFilters: Filters = { page: 1, pageSize: 25 };

export default function JobsPage() {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const jobs = useJobs(filters);
  const repositories = useRepositories();
  const update = (next: Partial<Filters>) => setFilters((current) => ({ ...current, ...next, page: next.page ?? 1 }));

  if ((jobs.isPending && !jobs.data) || repositories.isPending) return <PageSkeleton label="Loading job history" />;
  if (jobs.error || repositories.error || !jobs.data || !repositories.data) return <PageError error={jobs.error ?? repositories.error} retry={() => void Promise.all([jobs.refetch(), repositories.refetch()])} />;

  return (
    <>
      <PageHeader eyebrow="Durable history" title="Jobs" description="Search and filter every worker attempt without losing prior outcomes." />
      <JobFilters filters={filters} repositories={repositories.data} onUpdate={update} onReset={() => setFilters(initialFilters)} />
      <JobHistory jobs={jobs.data} filters={filters} fetching={jobs.isFetching} onPage={(page) => update({ page })} />
    </>
  );
}

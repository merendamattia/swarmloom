"use client";

import { FilterX, Search } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import type { JobFilters as Filters, Repositories } from "@/hooks/api";

const statuses = ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "BLOCKED", "DECOMPOSED", "CANCELLED", "STALE"];
const jobTypes = ["IMPLEMENTATION", "FIX", "REVIEW", "DECOMPOSITION"];

export function JobFilters({ filters, repositories, onUpdate, onReset }: {
  filters: Filters;
  repositories: Repositories;
  onUpdate: (next: Partial<Filters>) => void;
  onReset: () => void;
}) {
  const [query, setQuery] = useState(filters.q ?? "");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = query.trim();
    onUpdate({ q: value || undefined });
  };
  const reset = () => {
    setQuery("");
    onReset();
  };
  const hasFilters = Boolean(query || filters.q || filters.jobType || filters.status || filters.provider || filters.repositoryId);

  return (
    <form className="filters" onSubmit={submit} role="search">
      <div className="filter-search-row">
        <Field htmlFor="job-search" label="Issue, PR number, or repository"><Input id="job-search" name="q" type="search" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100} placeholder="Search job history" /></Field>
        <div className="filter-actions"><Button variant="primary" type="submit"><Search aria-hidden="true" />Search</Button><Button variant="secondary" onClick={reset} disabled={!hasFilters}><FilterX aria-hidden="true" />Reset</Button></div>
      </div>
      <div className="filter-grid">
        <Field htmlFor="job-type" label="Job kind"><Select id="job-type" value={filters.jobType ?? ""} onChange={(event) => onUpdate({ jobType: event.target.value || undefined })}><option value="">All kinds</option>{jobTypes.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</Select></Field>
        <Field htmlFor="job-status" label="Status"><Select id="job-status" value={filters.status ?? ""} onChange={(event) => onUpdate({ status: event.target.value || undefined })}><option value="">All statuses</option>{statuses.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</Select></Field>
        <Field htmlFor="job-provider" label="Provider"><Select id="job-provider" value={filters.provider ?? ""} onChange={(event) => onUpdate({ provider: event.target.value || undefined })}><option value="">All providers</option><option value="CODEX">Codex</option><option value="OPENCODE">OpenCode</option></Select></Field>
        <Field htmlFor="job-repository" label="Repository"><Select id="job-repository" value={filters.repositoryId ?? ""} onChange={(event) => onUpdate({ repositoryId: event.target.value || undefined })}><option value="">All repositories</option>{repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.fullName}</option>)}</Select></Field>
      </div>
    </form>
  );
}

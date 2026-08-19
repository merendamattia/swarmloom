"use client";

import { CircleAlert, Play, Trash2 } from "lucide-react";
import Link from "next/link";
import { ActionMessage, EmptyState, PageError, PageHeader, PageSkeleton, SectionHeading, StatusPill } from "@/components/operational";
import { useRemoveRepository, useRepositories, useRunScan } from "@/hooks/api";
import type { Repositories } from "@/hooks/api";
import { dateTime, shortCommit } from "@/lib/format";

export default function RepositoriesPage() {
  const repositories = useRepositories();
  const runScan = useRunScan();

  if (repositories.isPending) return <PageSkeleton label="Loading repositories" />;
  if (repositories.error || !repositories.data) return <PageError error={repositories.error} retry={() => void repositories.refetch()} />;

  return (
    <>
      <PageHeader eyebrow="Source boundary" title="Repositories" description="Validity, develop baselines, and recent work for every configured GitHub repository." actions={<button className="button primary" type="button" onClick={() => runScan.mutate()} disabled={runScan.isPending}><Play size={16} aria-hidden="true" />{runScan.isPending ? "Starting scan…" : "Run now"}</button>} />
      <ActionMessage pending={runScan.isPending} error={runScan.error} success={runScan.isSuccess} pendingText="Refreshing origin/develop for every repository…" />
      <section className="panel">
        <SectionHeading title="Configured repositories" description={`${repositories.data.length} ${repositories.data.length === 1 ? "repository" : "repositories"}. No fallback from the required develop branch.`} />
        {repositories.data.length ? <div className="repo-list">{repositories.data.map((repository) => (
          <RepositoryCard key={repository.id} repository={repository} />
        ))}</div> : <EmptyState title="No repositories configured" description="Set GITHUB_REPOSITORIES and restart the application before running a scan." />}
      </section>
    </>
  );
}

function RepositoryCard({ repository }: { repository: Repositories[number] }) {
  const remove = useRemoveRepository();
  const confirmRemove = () => {
    if (window.confirm(`Remove ${repository.fullName} from configured repositories? Its persisted record, events, and job history will be deleted. Cancel or finish any active jobs first.`)) {
      remove.mutate(repository.id);
    }
  };
  return (
    <article className="repository-card">
      <div className="repository-head"><div><h2>{repository.fullName}</h2><p className="muted">{repository.developAvailable ? "origin/develop is available and synchronized during scans." : "origin/develop is not available for worker jobs."}</p></div><div className="repository-actions"><StatusPill status={repository.status} /><button className="button danger" type="button" onClick={confirmRemove} disabled={remove.isPending}><Trash2 size={16} aria-hidden="true" />{remove.isPending ? "Removing…" : "Remove"}</button></div></div>
      {repository.errorMessage ? <div className="notice" role="alert"><CircleAlert size={19} aria-hidden="true" /><div><strong>Repository cannot be processed</strong><p>{repository.errorMessage}</p></div></div> : null}
      <dl className="repository-facts">
        <div className="fact"><dt>Develop</dt><dd>{repository.developAvailable ? "Available" : "Unavailable"}</dd></div>
        <div className="fact"><dt>Baseline</dt><dd className="mono" title={repository.baselineCommit ?? undefined}>{shortCommit(repository.baselineCommit)}</dd></div>
        <div className="fact"><dt>Last scan</dt><dd>{dateTime(repository.lastScannedAt)}</dd></div>
        <div className="fact"><dt>Local clone</dt><dd className="mono">{repository.localPath ?? "Not created"}</dd></div>
      </dl>
      <div className="repository-jobs"><h3>Recent jobs</h3>{repository.jobs.length ? repository.jobs.map((job) => <div className="repository-job" key={job.id}><StatusPill status={job.status} /><Link href={`/jobs/${job.id}`}>#{job.issueNumber} {job.issueTitle}</Link><span className="list-meta">{dateTime(job.createdAt)}</span></div>) : <EmptyState title="No jobs recorded" description="A ready-labelled issue will appear after the next successful scan." />}</div>
      <ActionMessage pending={remove.isPending} error={remove.error} success={remove.isSuccess} pendingText={`Removing ${repository.fullName}…`} successText="Repository removed." />
    </article>
  );
}

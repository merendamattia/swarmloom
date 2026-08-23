"use client";

import { CircleAlert, Trash2 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FactList } from "@/components/ui/fact-list";
import { ActionMessage } from "@/components/ui/feedback";
import { StatusPill } from "@/components/ui/status-pill";
import { useRemoveRepository, type Repositories } from "@/hooks/api";
import { dateTime, shortCommit } from "@/lib/format";

export function RepositoryCard({ repository }: { repository: Repositories[number] }) {
  const remove = useRemoveRepository();
  const confirmRemove = () => {
    if (window.confirm(`Remove ${repository.fullName} from configured repositories? Its persisted record, events, and job history will be deleted. Cancel or finish any active jobs first.`)) {
      remove.mutate(repository.id);
    }
  };
  return (
    <article className="repository-card">
      <div className="repository-head">
        <div><h2>{repository.fullName}</h2><p className="muted">{repository.developAvailable ? "origin/develop is available and synchronized during scans." : "origin/develop is not available for worker jobs."}</p></div>
        <div className="repository-actions"><StatusPill status={repository.status} /><Button variant="danger" onClick={confirmRemove} disabled={remove.isPending}><Trash2 aria-hidden="true" />{remove.isPending ? "Removing…" : "Remove"}</Button></div>
      </div>
      {repository.errorMessage ? <div className="notice" role="alert"><CircleAlert aria-hidden="true" /><div><strong>Repository cannot be processed</strong><p>{repository.errorMessage}</p></div></div> : null}
      <FactList className="repository-facts" items={[
        { label: "Develop", value: repository.developAvailable ? "Available" : "Unavailable" },
        { label: "Baseline", value: shortCommit(repository.baselineCommit), mono: true, title: repository.baselineCommit ?? undefined },
        { label: "Last scan", value: dateTime(repository.lastScannedAt) },
        { label: "Local clone", value: repository.localPath ?? "Not created", mono: true },
      ]} />
      <div className="repository-jobs">
        <h3>Recent jobs</h3>
        {repository.jobs.length
          ? repository.jobs.map((job) => <div className="repository-job" key={job.id}><StatusPill status={job.status} /><Link href={`/jobs/${job.id}`}>#{job.issueNumber} {job.issueTitle}</Link><span className="list-meta">{dateTime(job.createdAt)}</span></div>)
          : <EmptyState title="No jobs recorded" description="A ready-labelled issue will appear after the next successful scan." />}
      </div>
      <ActionMessage pending={remove.isPending} error={remove.error} success={remove.isSuccess} pendingText={`Removing ${repository.fullName}…`} successText="Repository removed." />
    </article>
  );
}

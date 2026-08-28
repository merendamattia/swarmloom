"use client";

import { ChevronRight, CircleAlert, GitBranch, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FactList } from "@/components/ui/fact-list";
import { ActionMessage } from "@/components/ui/feedback";
import { StatusPill } from "@/components/ui/status-pill";
import { useRemoveRepository, type Repositories } from "@/hooks/api";
import { dateTime, shortCommit, statusLabel, subjectLabel } from "@/lib/format";

export function RepositoryCard({ repository }: { repository: Repositories[number] }) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const remove = useRemoveRepository();
  return (
    <article className="repository-card">
      <div className="repository-head">
        <div className="repository-identity"><span className="repository-icon"><GitBranch aria-hidden="true" /></span><div><h2>{repository.fullName}</h2><p className="muted">{repository.developAvailable ? "origin/develop is available and synchronized during scans." : "origin/develop is not available for worker jobs."}</p></div></div>
        <div className="repository-actions"><StatusPill status={repository.status} /><Button variant="danger" onClick={() => setConfirmingRemove(true)} disabled={remove.isPending}><Trash2 aria-hidden="true" />{remove.isPending ? "Removing…" : "Remove"}</Button></div>
      </div>
      {repository.errorMessage ? <div className="notice" role="alert"><CircleAlert aria-hidden="true" /><div><strong>Repository cannot be processed</strong><p>{repository.errorMessage}</p></div></div> : null}
      <FactList className="repository-facts" items={[
        { label: "Develop", value: repository.developAvailable ? "Available" : "Unavailable" },
        { label: "Baseline", value: shortCommit(repository.baselineCommit), mono: true, title: repository.baselineCommit ?? undefined },
        { label: "Last scan", value: dateTime(repository.lastScannedAt) },
        { label: "Local clone", value: repository.localPath ?? "Not created", mono: true },
      ]} />
      <div className="repository-jobs">
        <div className="repository-jobs-heading"><h3>Recent jobs</h3><span>Latest five</span></div>
        {repository.jobs.length
          ? <ul className="repository-job-list">{repository.jobs.map((job) => <li key={job.id}><Link className="repository-job" href={`/jobs/${job.id}`}><StatusPill status={job.status} /><span className="repository-job-copy"><strong>{subjectLabel(job.subjectType, job.issueNumber, job.pullRequestNumber)} {job.issueTitle}</strong><span>{statusLabel(job.jobType)} · {statusLabel(job.provider)} · {job.reasoningEffort ? `${statusLabel(job.reasoningEffort)} reasoning` : "Provider default"} · {dateTime(job.createdAt)}</span></span><ChevronRight aria-hidden="true" /></Link></li>)}</ul>
          : <EmptyState title="No jobs recorded" description="A ready-labelled issue will appear after the next successful scan." tone="neutral" />}
      </div>
      <ActionMessage pending={remove.isPending} error={remove.error} success={remove.isSuccess} pendingText={`Removing ${repository.fullName}…`} successText="Repository removed." />
      <ConfirmDialog
        open={confirmingRemove}
        title={`Remove ${repository.fullName}?`}
        description="Its persisted record, events, and job history will be deleted. Cancel or finish any active jobs first."
        confirmLabel="Remove repository"
        onCancel={() => setConfirmingRemove(false)}
        onConfirm={() => {
          setConfirmingRemove(false);
          remove.mutate(repository.id);
        }}
      />
    </article>
  );
}

"use client";

import { CircleAlert } from "lucide-react";
import { useParams } from "next/navigation";
import { FailureDiagnostics } from "@/components/jobs/job-evidence";
import { JobFacts } from "@/components/jobs/job-facts";
import { JobHeader } from "@/components/jobs/job-header";
import { JobResult, JobReview, JobTimeline } from "@/components/jobs/job-sections";
import { PageError } from "@/components/ui/empty-state";
import { ActionMessage } from "@/components/ui/feedback";
import { Panel } from "@/components/ui/panel";
import { PageSkeleton } from "@/components/ui/skeleton";
import { useCancelJob, useJob, useRetryJob } from "@/hooks/api";
import { agentOutputEvents, subjectLabel, triggerLabel } from "@/lib/format";

export default function JobPage() {
  const id = String(useParams<{ id: string }>().id);
  const job = useJob(id);
  const cancel = useCancelJob(id);
  const retry = useRetryJob(id);

  if (job.isPending) return <PageSkeleton label="Loading job evidence" />;
  if (job.error || !job.data) return <PageError error={job.error} retry={() => void job.refetch()} />;

  const data = job.data;
  const subject = subjectLabel(data.subjectType, data.issueNumber, data.pullRequestNumber);
  const result = typeof data.result === "string" && data.result.trim() ? data.result : null;
  const review = typeof data.review?.response === "string" && data.review.response.trim() ? data.review.response : null;

  return (
    <>
      <JobHeader job={data} subject={subject} cancelling={cancel.isPending} retrying={retry.isPending} onCancel={() => cancel.mutate()} onRetry={() => retry.mutate()} />
      <ActionMessage pending={cancel.isPending || retry.isPending} error={cancel.error || retry.error} success={cancel.isSuccess || retry.isSuccess} pendingText={cancel.isPending ? "Cancelling the job…" : data.subjectType === "PULL_REQUEST" ? "Restoring the pull request label and starting a scan…" : "Restoring the ready label and starting a scan…"} />
      {data.errorMessage ? <div className="notice" role="alert"><CircleAlert aria-hidden="true" /><div><strong>The job requires attention</strong><p>{data.errorMessage}</p></div></div> : null}
      <div className="detail-grid">
        <div className="detail-main">
          {data.status === "FAILED" ? <Panel><FailureDiagnostics diagnostics={data.diagnostics} jobId={data.id} supportIssueNumber={data.supportIssueNumber ?? null} supportIssueUrl={data.supportIssueUrl ?? null} /></Panel> : null}
          <JobTimeline job={data} events={agentOutputEvents(data.events)} />
          <JobResult status={data.status} result={result} />
          <JobReview job={data} response={review} />
        </div>
        <JobFacts job={data} subject={subject} trigger={triggerLabel(data.trigger)} />
      </div>
    </>
  );
}

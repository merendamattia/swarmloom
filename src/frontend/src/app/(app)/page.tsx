"use client";

import { Play } from "lucide-react";
import { useState } from "react";
import { ActiveJobPanel } from "@/components/overview/active-job-panel";
import { ExceptionsPanel } from "@/components/overview/exceptions-panel";
import { OverviewHistory, RecentJobsSection } from "@/components/overview/overview-history";
import { SystemHealthCard } from "@/components/overview/system-health-card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageError } from "@/components/ui/empty-state";
import { ActionMessage } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { useClearDashboardExceptions, useDashboard, useHealth, useRunScan, useStatus } from "@/hooks/api";

export default function OverviewPage() {
  const [confirmingClear, setConfirmingClear] = useState(false);
  const dashboard = useDashboard();
  const health = useHealth();
  const status = useStatus();
  const clearExceptions = useClearDashboardExceptions();
  const runScan = useRunScan();
  const pending = dashboard.isPending || health.isPending || status.isPending;
  const error = dashboard.error || health.error || status.error;

  if (pending) return <PageSkeleton />;
  if (error || !dashboard.data || !health.data || !status.data) {
    return <PageError error={error} retry={() => void Promise.all([dashboard.refetch(), health.refetch(), status.refetch()])} />;
  }

  const invalidRepositories = dashboard.data.repositories.filter((repository) => repository.status === "INVALID" || repository.status === "ERROR");
  const needsAttention = health.data.services.worker.state !== "healthy" || invalidRepositories.length > 0 || dashboard.data.exceptionJobs.length > 0;
  return (
    <>
      <PageHeader eyebrow="Operations" title="Overview" description="Current health, exceptions, and durable worker activity." actions={<Button variant="primary" onClick={() => runScan.mutate()} disabled={runScan.isPending}><Play aria-hidden="true" />{runScan.isPending ? "Starting scan…" : "Run now"}</Button>} />
      <ActionMessage pending={clearExceptions.isPending} error={clearExceptions.error} success={clearExceptions.isSuccess} pendingText="Clearing resolved exceptions…" successText="Resolved exceptions cleared." />
      <ActionMessage pending={runScan.isPending} error={runScan.error} success={runScan.isSuccess} pendingText="Starting a manual scan…" />
      <SystemHealthCard dashboard={dashboard.data} health={health.data} status={status.data} needsAttention={needsAttention} />
      <div className="overview-grid">
        <ExceptionsPanel worker={health.data.services.worker} repositories={invalidRepositories} jobs={dashboard.data.exceptionJobs} clearing={clearExceptions.isPending} onClear={() => setConfirmingClear(true)} />
        <ActiveJobPanel job={dashboard.data.activeJobs[0]} queued={dashboard.data.jobs.QUEUED ?? 0} />
      </div>
      <RecentJobsSection jobs={dashboard.data.recentJobs} />
      <OverviewHistory repositories={dashboard.data.repositories} scans={dashboard.data.scans} />
      <ConfirmDialog
        open={confirmingClear}
        title="Clear resolved exceptions?"
        description="This removes resolved historical exceptions from the Overview. Jobs and timelines remain available in history."
        confirmLabel="Clear exceptions"
        onCancel={() => setConfirmingClear(false)}
        onConfirm={() => {
          setConfirmingClear(false);
          clearExceptions.mutate();
        }}
      />
    </>
  );
}

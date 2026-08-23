"use client";

import { Play } from "lucide-react";
import { RepositoryCard } from "@/components/repositories/repository-card";
import { Button } from "@/components/ui/button";
import { EmptyState, PageError } from "@/components/ui/empty-state";
import { ActionMessage } from "@/components/ui/feedback";
import { PageHeader, SectionHeading } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { PageSkeleton } from "@/components/ui/skeleton";
import { useRepositories, useRunScan } from "@/hooks/api";

export default function RepositoriesPage() {
  const repositories = useRepositories();
  const runScan = useRunScan();

  if (repositories.isPending) return <PageSkeleton label="Loading repositories" />;
  if (repositories.error || !repositories.data) return <PageError error={repositories.error} retry={() => void repositories.refetch()} />;

  return (
    <>
      <PageHeader eyebrow="Source boundary" title="Repositories" description="Validity, develop baselines, and recent work for every configured GitHub repository." actions={<Button variant="primary" onClick={() => runScan.mutate()} disabled={runScan.isPending}><Play aria-hidden="true" />{runScan.isPending ? "Starting scan…" : "Run now"}</Button>} />
      <ActionMessage pending={runScan.isPending} error={runScan.error} success={runScan.isSuccess} pendingText="Refreshing origin/develop for every repository…" />
      <Panel>
        <SectionHeading title="Configured repositories" description={`${repositories.data.length} ${repositories.data.length === 1 ? "repository" : "repositories"}. No fallback from the required develop branch.`} />
        {repositories.data.length ? <div className="repo-list">{repositories.data.map((repository) => (
          <RepositoryCard key={repository.id} repository={repository} />
        ))}</div> : <EmptyState title="No repositories configured" description="Set GITHUB_REPOSITORIES and restart the application before running a scan." />}
      </Panel>
    </>
  );
}

"use client";

import { SettingsEditor } from "@/components/settings/settings-editor";
import { PageError } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { useSettings } from "@/hooks/api";

export default function SettingsPage() {
  const settings = useSettings();
  if (settings.isPending) return <PageSkeleton label="Loading runtime settings" />;
  if (settings.error || !settings.data) return <PageError error={settings.error} retry={() => void settings.refetch()} />;
  return (
    <>
      <PageHeader eyebrow="Runtime control" title="Settings" description="Change operational behavior without rebuilding the application. Technical connections stay in the environment." />
      <SettingsEditor settings={settings.data} />
    </>
  );
}

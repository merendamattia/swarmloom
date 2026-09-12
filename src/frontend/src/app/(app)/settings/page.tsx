"use client";

import { SettingsEditor } from "@/components/settings/settings-editor";
import { PageError } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { useCodexGenerationOptions, useSettings } from "@/hooks/api";

export default function SettingsPage() {
  const settings = useSettings();
  const codexOptions = useCodexGenerationOptions();
  if (settings.isPending || codexOptions.isPending) return <PageSkeleton label="Loading runtime settings" />;
  if (settings.error || !settings.data) return <PageError error={settings.error} retry={() => void settings.refetch()} />;
  if (codexOptions.error || !codexOptions.data) return <PageError error={codexOptions.error} retry={() => void codexOptions.refetch()} />;
  return (
    <>
      <PageHeader eyebrow="Runtime control" title="Settings" description="Change operational behavior without rebuilding the application. Technical connections stay in the environment." />
      <SettingsEditor settings={settings.data} codexOptions={codexOptions.data} />
    </>
  );
}

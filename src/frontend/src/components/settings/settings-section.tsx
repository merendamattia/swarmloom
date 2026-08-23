import type { ReactNode } from "react";
import { SectionHeading } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";

export function SettingsSection({ title, description, action, children }: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return <Panel className="settings-card"><SectionHeading title={title} description={description} action={action} />{children}</Panel>;
}

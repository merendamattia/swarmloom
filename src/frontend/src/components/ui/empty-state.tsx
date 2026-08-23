import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function EmptyState({ title, description, action, tone = "success" }: {
  title: string;
  description: string;
  action?: ReactNode;
  tone?: "success" | "active" | "neutral";
}) {
  const Icon = tone === "active" ? LoaderCircle : CircleCheck;
  return (
    <div className="empty-state" data-tone={tone}>
      <Icon data-spin={tone === "active" || undefined} aria-hidden="true" />
      <div><h3>{title}</h3><p>{description}</p>{action}</div>
    </div>
  );
}

export function PageError({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : "The request failed.";
  return (
    <section className="state-panel state-error" role="alert">
      <CircleAlert aria-hidden="true" />
      <div><h2>Operational data is unavailable</h2><p>We could not reach the worker API: {message}</p></div>
      {retry ? <Button variant="secondary" onClick={retry}>Try again</Button> : null}
    </section>
  );
}

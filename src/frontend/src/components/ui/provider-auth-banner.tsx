import { CircleAlert } from "lucide-react";
import type { Status } from "@/hooks/api";

export function ProviderAuthBanner({ status }: { status: Status | undefined }) {
  const providerAuth = status?.providerAuth;
  if (!status || !providerAuth || providerAuth.status !== "required") return null;
  const provider = status.provider === "codex" ? "Codex" : "OpenCode";
  return (
    <aside className="provider-auth-banner" role="alert" aria-labelledby="provider-auth-title">
      <span className="provider-auth-icon" aria-hidden="true"><CircleAlert /></span>
      <div className="provider-auth-copy">
        <div className="provider-auth-heading"><p className="eyebrow">Action required</p><h2 id="provider-auth-title">{provider} login required</h2></div>
        <p>Jobs are paused until the configured provider is authenticated in the worker container.</p>
        <code className="provider-auth-command">{providerAuth.loginCommand}</code>
      </div>
    </aside>
  );
}

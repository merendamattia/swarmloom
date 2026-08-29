import { CircleAlert, CircleCheck } from "lucide-react";
import type { Dashboard, Health, Status } from "@/hooks/api";
import { statusLabel } from "@/lib/format";
import { ProviderUsageCard } from "@/components/overview/provider-usage-card";

const serviceStateLabel: Record<string, string> = {
  healthy: "Healthy",
  offline: "Offline",
  unavailable: "Unavailable",
};

export function SystemHealthCard({ dashboard, health, status, needsAttention }: {
  dashboard: Dashboard;
  health: Health;
  status: Status;
  needsAttention: boolean;
}) {
  const jobCount = Object.values(dashboard.jobs).reduce((sum, count) => sum + count, 0);
  const services = [
    { name: "API", ...health.services.api },
    { name: "Worker", ...health.services.worker },
    { name: "Database", ...health.services.database },
    { name: "Queue", ...health.services.queue },
    { name: "Scheduler", ...health.services.scheduler },
    {
      name: "Provider",
      state: status.providerAuth.status === "authenticated" ? "healthy" : "unavailable",
      detail: status.providerAuth.status === "authenticated" ? "Provider authenticated" : "Provider login required",
    },
    {
      name: "Telegram",
      state: status.telegram.operational ? "healthy" : "unavailable",
      detail: !status.telegram.configured ? "Disabled" : status.telegram.operational ? "Delivery confirmed" : "Configured, not yet confirmed",
    },
  ];
  const providerVersion = "providerVersion" in status ? String(status.providerVersion) : "Available";

  return (
    <section className="health-strip" data-health={needsAttention ? "attention" : "healthy"} aria-labelledby="health-title">
      <div className="health-summary">
        <span className="health-icon" aria-hidden="true">{needsAttention ? <CircleAlert size={23} /> : <CircleCheck size={23} />}</span>
        <div className="health-copy">
          <p className="eyebrow">System health</p>
          <h2 id="health-title">{needsAttention ? "Intervention is required" : "Operating normally"}</h2>
          <p>{needsAttention ? "Review the offline services and exceptions below before the next scheduled run." : "All services report healthy and no exception currently requires action."}</p>
        </div>
      </div>
      <dl className="health-facts">
        <div className="health-fact health-fact-wide"><dt>Services</dt><dd>
          <ul className="service-states">
            {services.map((service) => <li key={service.name} className="service-state" data-state={service.state} aria-label={`${service.name}: ${serviceStateLabel[service.state]}. ${service.detail}`}>{service.name}<span className="service-state-label">{serviceStateLabel[service.state]}</span></li>)}
          </ul>
        </dd></div>
        <div className="health-fact"><dt>Provider</dt><dd>{statusLabel(status.provider)}</dd></div>
        <div className="health-fact"><dt>Models</dt><dd>Coding: {status.agentProfiles.coding.model}<br />Review: {status.agentProfiles.review.model}</dd></div>
        <div className="health-fact"><dt>Version</dt><dd>{status.version}</dd></div>
        <div className="health-fact"><dt>Runtime</dt><dd>{providerVersion}</dd></div>
        <div className="health-fact"><dt>Schedule</dt><dd><span className="mono">{status.schedule.cron}</span> · {status.schedule.timezone}</dd></div>
        <div className="health-fact"><dt>Workload</dt><dd>{jobCount} total · {dashboard.jobs.QUEUED ?? 0} queued · {dashboard.jobs.RUNNING ?? 0} running</dd></div>
      </dl>
      <ProviderUsageCard provider={status.provider} usage={status.providerUsage} />
    </section>
  );
}

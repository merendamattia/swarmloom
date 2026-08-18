import type { Config } from "../core/config-schema.ts";

export type AgentLabelDefinition = {
  name: string;
  color: string;
  description: string;
};

export function agentLabelDefinitions(config: Config): AgentLabelDefinition[] {
  return [
    { name: config.ISSUE_READY_LABEL, color: "1f883d", description: "Issue is ready for automated implementation." },
    { name: config.ISSUE_WORKING_LABEL, color: "0969da", description: "Issue is currently being processed by the worker." },
    { name: config.ISSUE_BLOCKED_LABEL, color: "d4a72c", description: "Worker is blocked and needs additional information." },
    { name: config.ISSUE_COMPLETED_LABEL, color: "8250df", description: "Issue was implemented and reviewed by the worker." },
    { name: config.ISSUE_DECOMPOSED_LABEL, color: "bf8700", description: "Issue was split into smaller child issues." },
    { name: config.ISSUE_HUMAN_REVIEW_LABEL, color: "b60205", description: "Issue requires human review or intervention." },
  ];
}

export function replaceWorkerLabels(labels: string[], config: Config, nextLabels: string[]) {
  const workerLabels = new Set(agentLabelDefinitions(config).map(({ name }) => name));
  return [...new Set([...labels.filter((value) => !workerLabels.has(value)), ...nextLabels])];
}

import type { Config } from "../core/config-schema.ts";

export type AgentLabelDefinition = {
  name: string;
  color: string;
  description: string;
};

export function agentLabelDefinitions(config: Config): AgentLabelDefinition[] {
  return [...issueLabelDefinitions(config), ...pullRequestLabelDefinitions(config)];
}

export function issueLabelDefinitions(config: Config): AgentLabelDefinition[] {
  return [
    { name: config.ISSUE_READY_LABEL, color: "1f883d", description: "Issue is ready for automated implementation." },
    { name: config.ISSUE_WORKING_LABEL, color: "0969da", description: "Issue is currently being processed by the worker." },
    { name: config.ISSUE_BLOCKED_LABEL, color: "d4a72c", description: "Worker is blocked and needs additional information." },
    { name: config.ISSUE_COMPLETED_LABEL, color: "8250df", description: "Issue was implemented and its pull request merged." },
    { name: config.ISSUE_READY_TO_MERGE_LABEL, color: "0e8a16", description: "Automation passed; the pull request awaits a human merge." },
    { name: config.ISSUE_HUMAN_REVIEW_LABEL, color: "b60205", description: "Issue requires human review or intervention." },
  ];
}

export function pullRequestLabelDefinitions(config: Config): AgentLabelDefinition[] {
  return [
    { name: config.PR_REVIEW_REQUESTED_LABEL, color: "fbca04", description: "The pull request requires an automated review." },
    { name: config.PR_FIX_REQUESTED_LABEL, color: "d73a4a", description: "The pull request requires changes requested by the reviewer." },
    { name: config.PR_REVIEW_PASSED_LABEL, color: "0e8a16", description: "The automated review passed; the pull request awaits a human merge." },
  ];
}

export function replaceWorkerLabels(labels: string[], config: Config, nextLabels: string[]) {
  const workerLabels = new Set(issueLabelDefinitions(config).map(({ name }) => name));
  return [...new Set([...labels.filter((value) => !workerLabels.has(value)), ...nextLabels])];
}

export function replacePullRequestLabels(labels: string[], config: Config, nextLabels: string[]) {
  const prLabels = new Set([
    ...pullRequestLabelDefinitions(config).map(({ name }) => name),
    config.ISSUE_HUMAN_REVIEW_LABEL,
  ]);
  return [...new Set([...labels.filter((value) => !prLabels.has(value)), ...nextLabels])];
}

export function acquireIssueLabels(labels: string[], config: Config) {
  return replaceWorkerLabels(labels, config, [config.ISSUE_WORKING_LABEL]);
}

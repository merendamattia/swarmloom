import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodexGenerationOptions, Settings } from "@/hooks/api";
import { SettingsEditor } from "./settings-editor";

const settings = {
  githubRepositories: "acme/app",
  issueReadyLabel: "agent:ready",
  issueWorkingLabel: "agent:working",
  issueBlockedLabel: "agent:blocked",
  issueCompletedLabel: "agent:done",
  issueReadyToMergeLabel: "agent:ready-to-merge",
  issueHumanReviewLabel: "agent:human-review",
  prReviewRequestedLabel: "agent:review-requested",
  prFixRequestedLabel: "agent:fix-requested",
  prReviewPassedLabel: "agent:review-passed",
  maxAutomaticFixCycles: 5,
  createDiagnosticIssues: false,
  scheduleCron: "*/30 * * * *",
  maxParallelJobs: 1,
  agentProvider: "codex",
  opencodeCodingModel: "opencode-go/deepseek-v4-flash",
  opencodeReviewModel: "opencode-go/deepseek-v4-flash",
  codexCodingModel: "gpt-6.1-sol",
  codexReviewModel: "gpt-6.1-sol",
  codexCodingReasoningEffort: "medium",
  codexReviewReasoningEffort: "medium",
  telegramEnabled: false,
  telegramBotTokenConfigured: false,
  telegramChatIdConfigured: false,
  heartbeatIntervalMs: 10_000,
  staleJobThresholdMs: 60_000,
  agentTimeoutMs: 7_200_000,
} as Settings;

const codexOptions: CodexGenerationOptions = {
  models: [
    { slug: "gpt-6-luna", label: "GPT-6 Luna", description: "", defaultReasoningEffort: "max", reasoningEfforts: [
      { slug: "medium", label: "Medium", isDefault: false }, { slug: "max", label: "Max", isDefault: true },
    ] },
    { slug: "gpt-6.1-sol", label: "GPT-6.1 Sol", description: "", defaultReasoningEffort: "medium", reasoningEfforts: [
      { slug: "medium", label: "Medium", isDefault: true }, { slug: "max", label: "Max", isDefault: false },
    ] },
    { slug: "gpt-6-astra", label: "GPT-6 Astra", description: "", defaultReasoningEffort: "max", reasoningEfforts: [
      { slug: "medium", label: "Medium", isDefault: false }, { slug: "max", label: "Max", isDefault: true },
    ] },
  ],
};

describe("SettingsEditor", () => {
  test("shows the three active models with Sol 6.1 and Medium selected for both roles", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsEditor settings={settings} codexOptions={codexOptions} />
      </QueryClientProvider>,
    );

    for (const id of ["codex-coding-model", "codex-review-model"]) {
      const select = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>(.*?)</select>`))?.[1];
      expect(select?.match(/<option/g)).toHaveLength(3);
      expect(select).toContain('value="gpt-6-luna">GPT-6 Luna');
      expect(select).toContain('value="gpt-6.1-sol" selected="">GPT-6.1 Sol');
      expect(select).toContain('value="gpt-6-astra">GPT-6 Astra');
    }
    for (const id of ["codex-coding-reasoning", "codex-review-reasoning"]) {
      const select = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>(.*?)</select>`))?.[1];
      expect(select).toContain('value="medium" selected="">Medium');
    }
  });
});

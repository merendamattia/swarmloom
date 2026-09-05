"use client";

import { BellRing, Save } from "lucide-react";
import { type FormEvent, useState } from "react";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { ActionMessage } from "@/components/ui/feedback";
import { CheckboxField, Field, Input, Select } from "@/components/ui/field";
import { TagInput } from "@/components/ui/tag-input";
import { type CodexGenerationOptions, type Settings, type SettingsPatch, useTestNotification, useUpdateSettings } from "@/hooks/api";
import { modelForSlug, reasoningEffortForModel } from "@/lib/codex-catalog";
import { describeCron, millisecondsToSeconds, parseRepositoryList, removeRepository as removeRepositoryFromList, secondsToMilliseconds, timingStepSeconds } from "@/lib/settings";

type SettingsDraft = Omit<SettingsPatch, "githubRepositories" | "scheduleTimezone"> & {
  githubRepositories: string[];
  issueReadyLabel: string;
  issueWorkingLabel: string;
  issueBlockedLabel: string;
  issueCompletedLabel: string;
  issueDecomposedLabel: string;
  issueReadyToMergeLabel: string;
  issueHumanReviewLabel: string;
  prReviewRequestedLabel: string;
  prFixRequestedLabel: string;
  prReviewPassedLabel: string;
  maxAutomaticFixCycles: number;
  createDiagnosticIssues: boolean;
  scheduleCron: string;
  maxParallelJobs: number;
  agentProvider: "codex" | "opencode";
  opencodeCodingModel: string;
  opencodeReviewModel: string;
  codexCodingModel: string;
  codexReviewModel: string;
  codexCodingReasoningEffort: string;
  codexReviewReasoningEffort: string;
  telegramEnabled: boolean;
  heartbeatIntervalMs: number;
  staleJobThresholdMs: number;
  agentTimeoutMs: number;
  telegramBotToken: string;
  telegramChatId: string;
};

function toDraft(settings: Settings, codexOptions: CodexGenerationOptions): SettingsDraft {
  return {
    githubRepositories: parseRepositoryList(settings.githubRepositories),
    issueReadyLabel: settings.issueReadyLabel,
    issueWorkingLabel: settings.issueWorkingLabel,
    issueBlockedLabel: settings.issueBlockedLabel,
    issueCompletedLabel: settings.issueCompletedLabel,
    issueDecomposedLabel: settings.issueDecomposedLabel,
    issueReadyToMergeLabel: settings.issueReadyToMergeLabel,
    issueHumanReviewLabel: settings.issueHumanReviewLabel,
    prReviewRequestedLabel: settings.prReviewRequestedLabel,
    prFixRequestedLabel: settings.prFixRequestedLabel,
    prReviewPassedLabel: settings.prReviewPassedLabel,
    maxAutomaticFixCycles: settings.maxAutomaticFixCycles,
    createDiagnosticIssues: settings.createDiagnosticIssues,
    scheduleCron: settings.scheduleCron,
    maxParallelJobs: settings.maxParallelJobs,
    agentProvider: settings.agentProvider,
    opencodeCodingModel: settings.opencodeCodingModel,
    opencodeReviewModel: settings.opencodeReviewModel,
    codexCodingModel: settings.codexCodingModel,
    codexReviewModel: settings.codexReviewModel,
    codexCodingReasoningEffort: reasoningEffortForModel(codexOptions, settings.codexCodingModel, settings.codexCodingReasoningEffort),
    codexReviewReasoningEffort: reasoningEffortForModel(codexOptions, settings.codexReviewModel, settings.codexReviewReasoningEffort),
    telegramEnabled: settings.telegramEnabled,
    heartbeatIntervalMs: settings.heartbeatIntervalMs,
    staleJobThresholdMs: settings.staleJobThresholdMs,
    agentTimeoutMs: settings.agentTimeoutMs,
    telegramBotToken: "",
    telegramChatId: "",
  };
}

export function SettingsEditor({ settings, codexOptions }: { settings: Settings; codexOptions: CodexGenerationOptions }) {
  const save = useUpdateSettings();
  const testNotification = useTestNotification();
  const [draft, setDraft] = useState<SettingsDraft>(() => toDraft(settings, codexOptions));
  const [repositoryInput, setRepositoryInput] = useState("");
  const [editingTelegram, setEditingTelegram] = useState(false);
  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const updateCodexModel = (profile: "coding" | "review", model: string) => setDraft((current) => {
    const currentEffort = profile === "coding" ? current.codexCodingReasoningEffort : current.codexReviewReasoningEffort;
    const nextEffort = reasoningEffortForModel(codexOptions, model, currentEffort);
    return profile === "coding"
      ? { ...current, codexCodingModel: model, codexCodingReasoningEffort: nextEffort }
      : { ...current, codexReviewModel: model, codexReviewReasoningEffort: nextEffort };
  });
  const addRepositories = (value: string) => {
    const repositories = parseRepositoryList(value);
    if (!repositories.length) return;
    setDraft((current) => ({ ...current, githubRepositories: [...new Set([...current.githubRepositories, ...repositories])] }));
    setRepositoryInput("");
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { telegramBotToken, telegramChatId, githubRepositories, ...values } = draft;
    if (!githubRepositories.length) return;
    save.mutate({
      ...values,
      githubRepositories: githubRepositories.join(", "),
      ...(telegramBotToken ? { telegramBotToken } : {}),
      ...(telegramChatId ? { telegramChatId } : {}),
    });
  };
  const telegramDataConfigured = settings.telegramBotTokenConfigured || settings.telegramChatIdConfigured;
  const telegramFieldsLocked = telegramDataConfigured && !editingTelegram;

  return (
    <>
      <ActionMessage pending={save.isPending} error={save.error} success={save.isSuccess} pendingText="Saving runtime settings…" successText="Settings saved." variant="toast" />
      <form className="settings-form" onSubmit={submit}>
        <SettingsSection title="Agent execution" description="Each queued job snapshots its role's provider, model, and reasoning. Codex model and effort choices come from the enabled catalog. Coding covers implementation, fixes, and decomposition; review covers independent pull request reviews.">
          <div className="settings-grid">
            <Field htmlFor="agent-provider" label="Agent provider"><Select id="agent-provider" value={draft.agentProvider} onChange={(event) => set("agentProvider", event.target.value as SettingsDraft["agentProvider"])}><option value="codex">Codex</option><option value="opencode">OpenCode</option></Select></Field>
            <Field htmlFor="parallel-jobs" label="Parallel jobs"><Input id="parallel-jobs" type="number" min={1} max={20} value={draft.maxParallelJobs} onChange={(event) => set("maxParallelJobs", Number(event.target.value))} /></Field>
            {draft.agentProvider === "codex" ? (
              <>
                <Field htmlFor="codex-coding-model" label="Coding agent model" description="Used for IMPLEMENTATION, FIX, and DECOMPOSITION jobs."><Select id="codex-coding-model" value={draft.codexCodingModel} onChange={(event) => updateCodexModel("coding", event.target.value)}>{codexOptions.models.map((model) => <option key={model.slug} value={model.slug}>{model.label}</option>)}</Select></Field>
                <Field htmlFor="codex-coding-reasoning" label="Coding reasoning" description="Only efforts supported by the selected coding model are shown."><Select id="codex-coding-reasoning" value={draft.codexCodingReasoningEffort} onChange={(event) => set("codexCodingReasoningEffort", event.target.value)}>{(modelForSlug(codexOptions, draft.codexCodingModel)?.reasoningEfforts ?? []).map((effort) => <option key={effort.slug} value={effort.slug}>{effort.label}</option>)}</Select></Field>
                <Field htmlFor="codex-review-model" label="Review agent model" description="Used for REVIEW jobs."><Select id="codex-review-model" value={draft.codexReviewModel} onChange={(event) => updateCodexModel("review", event.target.value)}>{codexOptions.models.map((model) => <option key={model.slug} value={model.slug}>{model.label}</option>)}</Select></Field>
                <Field htmlFor="codex-review-reasoning" label="Review reasoning" description="Only efforts supported by the selected review model are shown."><Select id="codex-review-reasoning" value={draft.codexReviewReasoningEffort} onChange={(event) => set("codexReviewReasoningEffort", event.target.value)}>{(modelForSlug(codexOptions, draft.codexReviewModel)?.reasoningEfforts ?? []).map((effort) => <option key={effort.slug} value={effort.slug}>{effort.label}</option>)}</Select></Field>
              </>
            ) : (
              <>
                <Field htmlFor="opencode-coding-model" label="Coding agent model" description="Used for IMPLEMENTATION, FIX, and DECOMPOSITION jobs."><Input id="opencode-coding-model" value={draft.opencodeCodingModel} onChange={(event) => set("opencodeCodingModel", event.target.value)} /></Field>
                <Field htmlFor="opencode-review-model" label="Review agent model" description="Used for REVIEW jobs."><Input id="opencode-review-model" value={draft.opencodeReviewModel} onChange={(event) => set("opencodeReviewModel", event.target.value)} /></Field>
              </>
            )}
          </div>
        </SettingsSection>

        <SettingsSection title="Schedule and repositories" description="The API reloads the cron schedule immediately; the next scan uses the current repository list.">
          <div className="settings-grid">
            <Field htmlFor="repositories" label="GitHub repositories" description="Type a repository and press Enter to add it. At least one repository is required." wide><TagInput id="repositories" tags={draft.githubRepositories} value={repositoryInput} onValueChange={setRepositoryInput} onAdd={addRepositories} onRemove={(repository) => set("githubRepositories", removeRepositoryFromList(draft.githubRepositories, repository))} minimum={1} placeholder="owner/repository" /></Field>
            <Field htmlFor="cron" label="Schedule cron" description={describeCron(draft.scheduleCron)}><Input className="mono" id="cron" value={draft.scheduleCron} onChange={(event) => set("scheduleCron", event.target.value)} /></Field>
          </div>
        </SettingsSection>

        <SettingsSection title="Issue labels" description="These labels are synchronized on the configured repositories during startup and scans.">
          <div className="settings-grid">{([
            ["issueReadyLabel", "Ready label"], ["issueWorkingLabel", "Working label"], ["issueBlockedLabel", "Blocked label"],
            ["issueCompletedLabel", "Done label"], ["issueDecomposedLabel", "Decomposed label"], ["issueReadyToMergeLabel", "Ready to merge label"], ["issueHumanReviewLabel", "Human review label"],
          ] as const).map(([key, label]) => <Field htmlFor={key} label={label} key={key}><Input id={key} value={draft[key]} onChange={(event) => set(key, event.target.value)} /></Field>)}</div>
        </SettingsSection>

        <SettingsSection title="Pull request labels" description="Pull request state stays separate from issue state; these labels drive the fix/review reconciliation.">
          <div className="settings-grid">
            {([[
              "prReviewRequestedLabel", "Review requested"], ["prFixRequestedLabel", "Fix requested"], ["prReviewPassedLabel", "Review passed"],
            ] as const).map(([key, label]) => <Field htmlFor={key} label={label} key={key}><Input id={key} value={draft[key]} onChange={(event) => set(key, event.target.value)} /></Field>)}
            <Field htmlFor="fix-cycles" label="Automatic fix cycle limit" description="Consecutive automatic fixes per pull request before the workflow is blocked for human review."><Input id="fix-cycles" type="number" min={1} max={50} value={draft.maxAutomaticFixCycles} onChange={(event) => set("maxAutomaticFixCycles", Number(event.target.value))} /></Field>
          </div>
        </SettingsSection>

        <SettingsSection title="Telegram" description="Tokens are encrypted before they are stored in PostgreSQL and are never returned to the browser." action={<div className="section-actions">{telegramDataConfigured && !editingTelegram ? <Button variant="secondary" onClick={() => setEditingTelegram(true)}>Edit token and Chat ID</Button> : null}<Button variant="secondary" onClick={() => testNotification.mutate()} disabled={!draft.telegramEnabled || testNotification.isPending}><BellRing aria-hidden="true" />{testNotification.isPending ? "Sending…" : "Send test"}</Button></div>}>
          <div className="settings-grid">
            <CheckboxField checked={draft.telegramEnabled} onChange={(checked) => set("telegramEnabled", checked)}>Enable Telegram notifications</CheckboxField>
            <Field htmlFor="telegram-token" label="Bot token"><Input id="telegram-token" type="password" autoComplete="new-password" disabled={telegramFieldsLocked} value={draft.telegramBotToken} onChange={(event) => set("telegramBotToken", event.target.value)} placeholder={settings.telegramBotTokenConfigured ? "Configured, leave empty to keep" : "Paste bot token"} /></Field>
            <Field htmlFor="telegram-chat" label="Chat ID"><Input id="telegram-chat" disabled={telegramFieldsLocked} value={draft.telegramChatId} onChange={(event) => set("telegramChatId", event.target.value)} placeholder={settings.telegramChatIdConfigured ? "Configured, leave empty to keep" : "Paste chat ID"} /></Field>
          </div>
          <ActionMessage pending={testNotification.isPending} error={testNotification.error} success={testNotification.isSuccess} pendingText="Sending Telegram test message…" />
        </SettingsSection>

        <SettingsSection title="Worker timings" description="Tune operational limits without changing database, queue, or process connection settings.">
          <div className="settings-grid">
            <CheckboxField checked={draft.createDiagnosticIssues} onChange={(checked) => set("createDiagnosticIssues", checked)}>Open a diagnostic issue when a job fails</CheckboxField>
            <Field htmlFor="heartbeat" label="Heartbeat interval" help="How often a worker records that it is alive." description="Seconds"><Input id="heartbeat" type="number" min={1} step={timingStepSeconds} value={millisecondsToSeconds(draft.heartbeatIntervalMs)} onChange={(event) => set("heartbeatIntervalMs", secondsToMilliseconds(Number(event.target.value)))} /></Field>
            <Field htmlFor="stale" label="Stale threshold" help="How long a running job can go without a heartbeat before it is marked stale." description="Seconds"><Input id="stale" type="number" min={5} step={timingStepSeconds} value={millisecondsToSeconds(draft.staleJobThresholdMs)} onChange={(event) => set("staleJobThresholdMs", secondsToMilliseconds(Number(event.target.value)))} /></Field>
            <Field htmlFor="timeout" label="Agent timeout" help="The maximum time an agent may run before the worker stops it." description="Seconds"><Input id="timeout" type="number" min={60} step={timingStepSeconds} value={millisecondsToSeconds(draft.agentTimeoutMs)} onChange={(event) => set("agentTimeoutMs", secondsToMilliseconds(Number(event.target.value)))} /></Field>
          </div>
        </SettingsSection>

        <div className="settings-actions"><Button variant="primary" type="submit" disabled={save.isPending}><Save aria-hidden="true" />{save.isPending ? "Saving…" : "Save settings"}</Button></div>
      </form>
    </>
  );
}

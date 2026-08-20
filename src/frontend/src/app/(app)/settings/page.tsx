"use client";

import { BellRing, Info, Save, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  ActionMessage,
  PageError,
  PageHeader,
  PageSkeleton,
  SectionHeading,
} from "@/components/operational";
import {
  type Settings,
  type SettingsPatch,
  useSettings,
  useTestNotification,
  useUpdateSettings,
} from "@/hooks/api";
import {
  describeCron,
  millisecondsToSeconds,
  parseRepositoryList,
  secondsToMilliseconds,
} from "@/lib/settings";

type SettingsForm = Omit<SettingsPatch, "githubRepositories" | "scheduleTimezone"> & {
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
  opencodeModel: string;
  codexModel: string;
  codexReasoningEffort: NonNullable<SettingsPatch["codexReasoningEffort"]>;
  telegramEnabled: boolean;
  heartbeatIntervalMs: number;
  staleJobThresholdMs: number;
  agentTimeoutMs: number;
  telegramBotToken: string;
  telegramChatId: string;
};

function formFromSettings(settings: Settings): SettingsForm {
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
    opencodeModel: settings.opencodeModel,
    codexModel: settings.codexModel,
    codexReasoningEffort: settings.codexReasoningEffort ?? "max",
    telegramEnabled: settings.telegramEnabled,
    heartbeatIntervalMs: settings.heartbeatIntervalMs,
    staleJobThresholdMs: settings.staleJobThresholdMs,
    agentTimeoutMs: settings.agentTimeoutMs,
    telegramBotToken: "",
    telegramChatId: "",
  };
}

function FieldLabel({ htmlFor, help, children }: { htmlFor: string; help: string; children: string }) {
  return (
    <div className="field-label">
      <label htmlFor={htmlFor}>{children}</label>
      <span className="info-tip" tabIndex={0} title={help} aria-label={`More information: ${help}`}>
        <Info size={14} aria-hidden="true" />
      </span>
    </div>
  );
}

export default function SettingsPage() {
  const settings = useSettings();
  const save = useUpdateSettings();
  const testNotification = useTestNotification();
  const [draft, setDraft] = useState<SettingsForm | null>(null);
  const [repositoryInput, setRepositoryInput] = useState("");
  const [editingTelegram, setEditingTelegram] = useState(false);
  const form = draft ?? (settings.data ? formFromSettings(settings.data) : null);

  if (settings.isPending || !form) return <PageSkeleton label="Loading runtime settings" />;
  if (settings.error) return <PageError error={settings.error} retry={() => void settings.refetch()} />;

  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => {
    setDraft((current) => ({ ...(current ?? formFromSettings(settings.data!)), [key]: value }));
  };

  const addRepositories = (value: string) => {
    const repositories = parseRepositoryList(value);
    if (repositories.length === 0) return;
    setDraft((current) => {
      const next = current ?? formFromSettings(settings.data!);
      return { ...next, githubRepositories: [...new Set([...next.githubRepositories, ...repositories])] };
    });
    setRepositoryInput("");
  };

  const removeRepository = (repository: string) => {
    setDraft((current) => {
      const next = current ?? formFromSettings(settings.data!);
      return { ...next, githubRepositories: next.githubRepositories.filter((value) => value !== repository) };
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { telegramBotToken, telegramChatId, githubRepositories, ...values } = form;
    const patch: SettingsPatch = {
      ...values,
      githubRepositories: githubRepositories.join(", "),
      ...(telegramBotToken ? { telegramBotToken } : {}),
      ...(telegramChatId ? { telegramChatId } : {}),
    };
    save.mutate(patch);
  };

  const telegramDataConfigured = settings.data.telegramBotTokenConfigured || settings.data.telegramChatIdConfigured;
  const telegramFieldsLocked = telegramDataConfigured && !editingTelegram;

  return (
    <>
      <PageHeader eyebrow="Runtime control" title="Settings" description="Change operational behavior without rebuilding the application. Technical connections stay in the environment." />
      <ActionMessage pending={save.isPending} error={save.error} success={save.isSuccess} pendingText="Saving runtime settings…" successText="Settings saved." variant="toast" />
      <form className="settings-form" onSubmit={submit}>
        <section className="panel settings-card">
          <SectionHeading title="Agent execution" description="New jobs take a snapshot of the selected provider and model." />
          <div className="settings-grid">
            <div className="field"><label htmlFor="agent-provider">Agent provider</label><select className="select" id="agent-provider" value={form.agentProvider} onChange={(event) => set("agentProvider", event.target.value as SettingsForm["agentProvider"])}><option value="codex">Codex</option><option value="opencode">OpenCode</option></select></div>
            <div className="field"><label htmlFor="parallel-jobs">Parallel jobs</label><input className="input" id="parallel-jobs" type="number" min={1} max={20} value={form.maxParallelJobs} onChange={(event) => set("maxParallelJobs", Number(event.target.value))} /></div>
            <div className="field"><label htmlFor="codex-model">Codex model</label><input className="input" id="codex-model" value={form.codexModel} onChange={(event) => set("codexModel", event.target.value)} /></div>
            <div className="field"><label htmlFor="opencode-model">OpenCode model</label><input className="input" id="opencode-model" value={form.opencodeModel} onChange={(event) => set("opencodeModel", event.target.value)} /></div>
            <div className="field"><label htmlFor="reasoning">Codex reasoning</label><select className="select" id="reasoning" value={form.codexReasoningEffort} onChange={(event) => set("codexReasoningEffort", event.target.value as SettingsForm["codexReasoningEffort"])}>{["minimal", "low", "medium", "high", "xhigh", "max"].map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
          </div>
        </section>

        <section className="panel settings-card">
          <SectionHeading title="Schedule and repositories" description="The API reloads the cron schedule immediately; the next scan uses the current repository list." />
          <div className="settings-grid">
            <div className="field settings-wide">
              <label htmlFor="repositories">GitHub repositories</label>
              <div className="tag-input">
                <div className="tag-list" aria-live="polite">
                  {form.githubRepositories.map((repository) => (
                    <span className="tag" key={repository}>
                      {repository}
                      <button className="tag-remove" type="button" aria-label={`Remove ${repository}`} onClick={() => removeRepository(repository)}>
                        <X size={13} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
                <input
                  className="input"
                  id="repositories"
                  value={repositoryInput}
                  placeholder="owner/repository"
                  onChange={(event) => setRepositoryInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addRepositories(repositoryInput);
                    }
                  }}
                />
              </div>
              <p className="field-help">Type a repository and press Enter to add it.</p>
            </div>
            <div className="field"><label htmlFor="cron">Schedule cron</label><input className="input mono" id="cron" value={form.scheduleCron} onChange={(event) => set("scheduleCron", event.target.value)} /><p className="field-help" aria-live="polite">{describeCron(form.scheduleCron)}</p></div>
          </div>
        </section>

        <section className="panel settings-card">
          <SectionHeading title="Issue labels" description="These labels are synchronized on the configured repositories during startup and scans." />
          <div className="settings-grid">
            {([
              ["issueReadyLabel", "Ready label"], ["issueWorkingLabel", "Working label"], ["issueBlockedLabel", "Blocked label"],
              ["issueCompletedLabel", "Done label"], ["issueDecomposedLabel", "Decomposed label"], ["issueReadyToMergeLabel", "Ready to merge label"], ["issueHumanReviewLabel", "Human review label"],
            ] as const).map(([key, label]) => <div className="field" key={key}><label htmlFor={key}>{label}</label><input className="input" id={key} value={form[key]} onChange={(event) => set(key, event.target.value)} /></div>)}
          </div>
        </section>

        <section className="panel settings-card">
          <SectionHeading title="Pull request labels" description="Pull request state stays separate from issue state; these labels drive the fix/review reconciliation." />
          <div className="settings-grid">
            {([
              ["prReviewRequestedLabel", "Review requested"], ["prFixRequestedLabel", "Fix requested"], ["prReviewPassedLabel", "Review passed"],
            ] as const).map(([key, label]) => <div className="field" key={key}><label htmlFor={key}>{label}</label><input className="input" id={key} value={form[key]} onChange={(event) => set(key, event.target.value)} /></div>)}
            <div className="field"><label htmlFor="fix-cycles">Automatic fix cycle limit</label><input className="input" id="fix-cycles" type="number" min={1} max={50} value={form.maxAutomaticFixCycles} onChange={(event) => set("maxAutomaticFixCycles", Number(event.target.value))} /><p className="field-help">Consecutive automatic fixes per pull request before the workflow is blocked for human review.</p></div>
          </div>
        </section>

        <section className="panel settings-card">
          <SectionHeading
            title="Telegram"
            description="Tokens are encrypted before they are stored in PostgreSQL and are never returned to the browser."
            action={<div className="section-actions">
              {telegramDataConfigured && !editingTelegram ? <button className="button secondary" type="button" onClick={() => setEditingTelegram(true)}>Edit token and Chat ID</button> : null}
              <button className="button secondary" type="button" onClick={() => testNotification.mutate()} disabled={!form.telegramEnabled || testNotification.isPending}><BellRing size={16} aria-hidden="true" />{testNotification.isPending ? "Sending…" : "Send test"}</button>
            </div>}
          />
          <div className="settings-grid">
            <label className="toggle-field"><input type="checkbox" checked={form.telegramEnabled} onChange={(event) => set("telegramEnabled", event.target.checked)} /><span>Enable Telegram notifications</span></label>
            <div className="field"><label htmlFor="telegram-token">Bot token</label><input className="input" id="telegram-token" type="password" autoComplete="new-password" disabled={telegramFieldsLocked} value={form.telegramBotToken} onChange={(event) => set("telegramBotToken", event.target.value)} placeholder={settings.data.telegramBotTokenConfigured ? "Configured — leave empty to keep" : "Paste bot token"} /></div>
            <div className="field"><label htmlFor="telegram-chat">Chat ID</label><input className="input" id="telegram-chat" disabled={telegramFieldsLocked} value={form.telegramChatId} onChange={(event) => set("telegramChatId", event.target.value)} placeholder={settings.data.telegramChatIdConfigured ? "Configured — leave empty to keep" : "Paste chat ID"} /></div>
          </div>
          <ActionMessage pending={testNotification.isPending} error={testNotification.error} success={testNotification.isSuccess} pendingText="Sending Telegram test message…" />
        </section>

        <section className="panel settings-card">
          <SectionHeading title="Worker timings" description="Tune operational limits without changing database, queue, or process connection settings." />
          <div className="settings-grid">
            <label className="toggle-field"><input type="checkbox" checked={form.createDiagnosticIssues} onChange={(event) => set("createDiagnosticIssues", event.target.checked)} /><span>Open a diagnostic issue when a job fails</span></label>
            <div className="field"><FieldLabel htmlFor="heartbeat" help="How often a worker records that it is alive.">Heartbeat interval</FieldLabel><input className="input" id="heartbeat" type="number" min={1} step={1} value={millisecondsToSeconds(form.heartbeatIntervalMs)} onChange={(event) => set("heartbeatIntervalMs", secondsToMilliseconds(Number(event.target.value)))} /><p className="field-help">Seconds</p></div>
            <div className="field"><FieldLabel htmlFor="stale" help="How long a running job can go without a heartbeat before it is marked stale.">Stale threshold</FieldLabel><input className="input" id="stale" type="number" min={5} step={1} value={millisecondsToSeconds(form.staleJobThresholdMs)} onChange={(event) => set("staleJobThresholdMs", secondsToMilliseconds(Number(event.target.value)))} /><p className="field-help">Seconds</p></div>
            <div className="field"><FieldLabel htmlFor="timeout" help="The maximum time an agent may run before the worker stops it.">Agent timeout</FieldLabel><input className="input" id="timeout" type="number" min={60} step={1} value={millisecondsToSeconds(form.agentTimeoutMs)} onChange={(event) => set("agentTimeoutMs", secondsToMilliseconds(Number(event.target.value)))} /><p className="field-help">Seconds</p></div>
          </div>
        </section>

        <div className="settings-actions"><button className="button primary" type="submit" disabled={save.isPending}><Save size={16} aria-hidden="true" />{save.isPending ? "Saving…" : "Save settings"}</button></div>
      </form>
    </>
  );
}

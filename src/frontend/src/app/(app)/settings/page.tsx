"use client";

import { BellRing, Save } from "lucide-react";
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

type SettingsForm = SettingsPatch & {
  githubRepositories: string;
  issueReadyLabel: string;
  issueWorkingLabel: string;
  issueBlockedLabel: string;
  issueCompletedLabel: string;
  issueDecomposedLabel: string;
  issueHumanReviewLabel: string;
  scheduleCron: string;
  scheduleTimezone: string;
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
    githubRepositories: settings.githubRepositories,
    issueReadyLabel: settings.issueReadyLabel,
    issueWorkingLabel: settings.issueWorkingLabel,
    issueBlockedLabel: settings.issueBlockedLabel,
    issueCompletedLabel: settings.issueCompletedLabel,
    issueDecomposedLabel: settings.issueDecomposedLabel,
    issueHumanReviewLabel: settings.issueHumanReviewLabel,
    scheduleCron: settings.scheduleCron,
    scheduleTimezone: settings.scheduleTimezone,
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

export default function SettingsPage() {
  const settings = useSettings();
  const save = useUpdateSettings();
  const testNotification = useTestNotification();
  const [draft, setDraft] = useState<SettingsForm | null>(null);
  const form = draft ?? (settings.data ? formFromSettings(settings.data) : null);

  if (settings.isPending || !form) return <PageSkeleton label="Loading runtime settings" />;
  if (settings.error) return <PageError error={settings.error} retry={() => void settings.refetch()} />;

  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => {
    setDraft((current) => ({ ...(current ?? formFromSettings(settings.data!)), [key]: value }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { telegramBotToken, telegramChatId, ...values } = form;
    const patch: SettingsPatch = {
      ...values,
      ...(telegramBotToken ? { telegramBotToken } : {}),
      ...(telegramChatId ? { telegramChatId } : {}),
    };
    save.mutate(patch);
  };

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
            <div className="field settings-wide"><label htmlFor="repositories">GitHub repositories</label><input className="input" id="repositories" value={form.githubRepositories} onChange={(event) => set("githubRepositories", event.target.value)} /><p className="field-help">Comma or whitespace separated owner/repository values.</p></div>
            <div className="field"><label htmlFor="cron">Schedule cron</label><input className="input mono" id="cron" value={form.scheduleCron} onChange={(event) => set("scheduleCron", event.target.value)} /></div>
            <div className="field"><label htmlFor="timezone">Schedule timezone</label><input className="input" id="timezone" value={form.scheduleTimezone} onChange={(event) => set("scheduleTimezone", event.target.value)} /></div>
          </div>
        </section>

        <section className="panel settings-card">
          <SectionHeading title="Issue labels" description="These labels are synchronized on the configured repositories during startup and scans." />
          <div className="settings-grid">
            {([
              ["issueReadyLabel", "Ready label"], ["issueWorkingLabel", "Working label"], ["issueBlockedLabel", "Blocked label"],
              ["issueCompletedLabel", "Completed label"], ["issueDecomposedLabel", "Decomposed label"], ["issueHumanReviewLabel", "Human review label"],
            ] as const).map(([key, label]) => <div className="field" key={key}><label htmlFor={key}>{label}</label><input className="input" id={key} value={form[key]} onChange={(event) => set(key, event.target.value)} /></div>)}
          </div>
        </section>

        <section className="panel settings-card">
          <SectionHeading title="Telegram" description="Tokens are encrypted before they are stored in PostgreSQL and are never returned to the browser." action={<button className="button secondary" type="button" onClick={() => testNotification.mutate()} disabled={!form.telegramEnabled || testNotification.isPending}><BellRing size={16} aria-hidden="true" />{testNotification.isPending ? "Sending…" : "Send test"}</button>} />
          <div className="settings-grid">
            <label className="toggle-field"><input type="checkbox" checked={form.telegramEnabled} onChange={(event) => set("telegramEnabled", event.target.checked)} /><span>Enable Telegram notifications</span></label>
            <div className="field"><label htmlFor="telegram-token">Bot token</label><input className="input" id="telegram-token" type="password" autoComplete="new-password" value={form.telegramBotToken} onChange={(event) => set("telegramBotToken", event.target.value)} placeholder={settings.data.telegramBotTokenConfigured ? "Configured — leave empty to keep" : "Paste bot token"} /></div>
            <div className="field"><label htmlFor="telegram-chat">Chat ID</label><input className="input" id="telegram-chat" value={form.telegramChatId} onChange={(event) => set("telegramChatId", event.target.value)} placeholder={settings.data.telegramChatIdConfigured ? "Configured — leave empty to keep" : "Paste chat ID"} /></div>
          </div>
          <ActionMessage pending={testNotification.isPending} error={testNotification.error} success={testNotification.isSuccess} pendingText="Sending Telegram test message…" />
        </section>

        <section className="panel settings-card">
          <SectionHeading title="Worker timings" description="Tune operational limits without changing database, queue, or process connection settings." />
          <div className="settings-grid">
            <div className="field"><label htmlFor="heartbeat">Heartbeat interval (ms)</label><input className="input" id="heartbeat" type="number" min={1000} value={form.heartbeatIntervalMs} onChange={(event) => set("heartbeatIntervalMs", Number(event.target.value))} /></div>
            <div className="field"><label htmlFor="stale">Stale threshold (ms)</label><input className="input" id="stale" type="number" min={5000} value={form.staleJobThresholdMs} onChange={(event) => set("staleJobThresholdMs", Number(event.target.value))} /></div>
            <div className="field"><label htmlFor="timeout">Agent timeout (ms)</label><input className="input" id="timeout" type="number" min={60000} value={form.agentTimeoutMs} onChange={(event) => set("agentTimeoutMs", Number(event.target.value))} /></div>
          </div>
        </section>

        <div className="settings-actions"><button className="button primary" type="submit" disabled={save.isPending}><Save size={16} aria-hidden="true" />{save.isPending ? "Saving…" : "Save settings"}</button></div>
      </form>
    </>
  );
}

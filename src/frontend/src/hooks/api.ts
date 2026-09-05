"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api, json } from "@/lib/api-client";

export type Health = InferResponseType<typeof api.health.$get, 200>;
export type Status = InferResponseType<typeof api.status.$get, 200>;
export type Dashboard = InferResponseType<typeof api.dashboard.$get, 200>;
export type Jobs = InferResponseType<typeof api.jobs.$get, 200>;
export type Job = InferResponseType<typeof api.jobs[":id"]["$get"], 200>;
export type Repositories = InferResponseType<typeof api.repositories.$get, 200>;
export type Scans = InferResponseType<typeof api.scans.$get, 200>;
export type Settings = InferResponseType<typeof api.settings.$get, 200>;
export type CodexGenerationOptions = InferResponseType<typeof api.codex["generation-options"]["$get"], 200>;
export type SupportIssue = { status: "created" | "existing"; issueNumber: number; issueUrl: string };
export type SettingsPatch = {
  githubRepositories?: string;
  issueReadyLabel?: string;
  issueWorkingLabel?: string;
  issueBlockedLabel?: string;
  issueCompletedLabel?: string;
  issueDecomposedLabel?: string;
  issueReadyToMergeLabel?: string;
  issueHumanReviewLabel?: string;
  prReviewRequestedLabel?: string;
  prFixRequestedLabel?: string;
  prReviewPassedLabel?: string;
  maxAutomaticFixCycles?: number;
  createDiagnosticIssues?: boolean;
  scheduleCron?: string;
  scheduleTimezone?: string;
  maxParallelJobs?: number;
  agentProvider?: "codex" | "opencode";
  opencodeCodingModel?: string;
  opencodeReviewModel?: string;
  codexCodingModel?: string;
  codexReviewModel?: string;
  codexCodingReasoningEffort?: string;
  codexReviewReasoningEffort?: string;
  telegramEnabled?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  heartbeatIntervalMs?: number;
  staleJobThresholdMs?: number;
  agentTimeoutMs?: number;
};

export type JobFilters = {
  status?: string;
  jobType?: string;
  subjectType?: string;
  provider?: string;
  repositoryId?: string;
  q?: string;
  page: number;
  pageSize: number;
};

const activeStatuses = new Set(["QUEUED", "RUNNING"]);

export function useHealth() {
  return useQuery({ queryKey: ["health"], queryFn: async () => json<Health>(await api.health.$get()) });
}

export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: async () => json<Status>(await api.status.$get()),
    refetchInterval: (query) => (query.state.data as Status | undefined)?.providerAuth.status === "required" ? 5_000 : false,
  });
}

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: async () => json<Settings>(await api.settings.$get()) });
}

export function useCodexGenerationOptions() {
  return useQuery({
    queryKey: ["codex-generation-options"],
    queryFn: async () => json<CodexGenerationOptions>(await api.codex["generation-options"].$get()),
  });
}

export function useDashboard() {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => json<Dashboard>(await api.dashboard.$get()),
    refetchInterval: (query) => {
      const data = query.state.data as Dashboard | undefined;
      return data && (data.activeJobs.length > 0 || Object.entries(data.jobs).some(([status, count]) => activeStatuses.has(status) && count > 0))
        ? 3_000
        : false;
    },
  });
}

export function useJobs(filters: JobFilters) {
  return useQuery({
    queryKey: ["jobs", filters],
    queryFn: async () => json<Jobs>(await api.jobs.$get({ query: {
      page: String(filters.page),
      pageSize: String(filters.pageSize),
      ...(filters.status ? { status: filters.status as "QUEUED" } : {}),
      ...(filters.jobType ? { jobType: filters.jobType as "FIX" } : {}),
      ...(filters.subjectType ? { subjectType: filters.subjectType as "PULL_REQUEST" } : {}),
      ...(filters.provider ? { provider: filters.provider as "CODEX" } : {}),
      ...(filters.repositoryId ? { repositoryId: filters.repositoryId } : {}),
      ...(filters.q ? { q: filters.q } : {}),
    } })),
    placeholderData: (previous) => previous,
    refetchInterval: (query) => (query.state.data as Jobs | undefined)?.items.some((job) => activeStatuses.has(job.status)) ? 3_000 : false,
  });
}

export function useJob(id: string) {
  return useQuery({
    queryKey: ["jobs", id],
    queryFn: async () => json<Job>(await api.jobs[":id"].$get({ param: { id } })),
    refetchInterval: (query) => activeStatuses.has((query.state.data as Job | undefined)?.status ?? "") ? 2_000 : false,
  });
}

export function useRepositories() {
  return useQuery({ queryKey: ["repositories"], queryFn: async () => json<Repositories>(await api.repositories.$get()) });
}

function useAction<TArgs = void>(action: (args: TArgs) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: action,
    onSuccess: async () => Promise.all([
      client.invalidateQueries({ queryKey: ["dashboard"] }),
      client.invalidateQueries({ queryKey: ["jobs"] }),
      client.invalidateQueries({ queryKey: ["repositories"] }),
      client.invalidateQueries({ queryKey: ["status"] }),
      client.invalidateQueries({ queryKey: ["settings"] }),
    ]),
  });
}

export function useRunScan() {
  return useAction(async () => json(await api.scans.run.$post()));
}

export function useRemoveRepository() {
  return useAction(async (id: string) => json(await api.repositories[":id"].$delete({ param: { id } })));
}

export function useCancelJob(id: string) {
  return useAction(async () => json(await api.jobs[":id"].cancel.$post({ param: { id } })));
}

export function useRetryJob(id: string) {
  return useAction(async () => json(await api.jobs[":id"].retry.$post({ param: { id } })));
}

export function useCreateSupportIssue(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => json<SupportIssue>(await api.jobs[":id"]["support-issue"].$post({ param: { id } })),
    onSuccess: async () => Promise.all([
      client.invalidateQueries({ queryKey: ["jobs", id] }),
      client.invalidateQueries({ queryKey: ["jobs"] }),
    ]),
  });
}

export function useTestNotification() {
  return useAction(async () => json(await api.notifications.test.$post()));
}

export function useClearDashboardExceptions() {
  return useAction(async () => json(await api.dashboard.exceptions.clear.$post()));
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: SettingsPatch) => json<Settings>(await api.settings.$patch({ json: input })),
    onSuccess: async () => Promise.all([
      client.invalidateQueries({ queryKey: ["settings"] }),
      client.invalidateQueries({ queryKey: ["status"] }),
      client.invalidateQueries({ queryKey: ["dashboard"] }),
    ]),
  });
}

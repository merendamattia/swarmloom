import type { Config } from "../core/config-schema.ts";
import type { EventService } from "../events/service.ts";
import { createJobWorktree, createReviewWorktree, gcRepository, removeJobWorktree } from "../git/repositories.ts";
import type { GitHubClient, GitHubIssueContext } from "../github/client.ts";
import type { AgentProvider, AgentRole } from "../providers/index.ts";
import type { JobQueue } from "../queue/service.ts";
import { jobRepository } from "../repositories/jobs.ts";

export type RunningJob = NonNullable<Awaited<ReturnType<typeof jobRepository.findRunning>>>;

export type RunnerGitHub = Pick<GitHubClient,
  "getIssue" | "getIssueContext" | "getPullRequest" | "getPullRequestDiff" |
  "getPullRequestLabels" | "setPullRequestLabels" |
  "createIssue" | "setIssueLabels" | "addIssueComment">;

export type CreateWorktree = typeof createJobWorktree;
export type CreateReviewWorktree = typeof createReviewWorktree;
export type RemoveWorktree = typeof removeJobWorktree;
export type GcRepository = typeof gcRepository;

export type SessionState = {
  worktreePath?: string;
  worktreeCreated: boolean;
  repositoryPath?: string;
  activePullRequest?: { number: number; url: string };
  liveContext?: GitHubIssueContext;
};

export type ExecuteRoleWithRetry = (
  role: AgentRole,
  task: string,
  context: string,
  parse: (response: string) => void,
  workingDirectory: string,
  abortSignal: AbortSignal,
  job: RunningJob,
) => Promise<{ exitCode: number; sessionId: string | null; stderr: string; response: string }>;

export type RunnerContext = {
  config: Config;
  github: RunnerGitHub;
  events: EventService;
  queue: Pick<JobQueue, "enqueue">;
  createWorktree: CreateWorktree;
  createReviewWorktree: CreateReviewWorktree;
  job: RunningJob;
  provider: AgentProvider;
  signal: AbortSignal;
  state: SessionState;
  executeRoleWithRetry: ExecuteRoleWithRetry;
  finalizeIssue: (job: RunningJob, labels: string[], comment: string) => Promise<void>;
  commentOnPullRequest: (job: RunningJob, pullRequestNumber: number, comment: string) => Promise<void>;
};

export type JobFlow = (context: RunnerContext) => Promise<void>;

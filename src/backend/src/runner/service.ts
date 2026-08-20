import type { Config } from "../core/config-schema.ts";
import type { EventService } from "../events/service.ts";
import {
  createJobWorktree as createTargetWorktree,
  createReviewWorktree as createTargetReviewWorktree,
  gcRepository,
  removeJobWorktree as removeTargetWorktree,
} from "../git/repositories.ts";
import { githubGitEnvironment } from "../github/git-auth.ts";
import type { AgentProvider } from "../providers/index.ts";
import { eventRepository } from "../repositories/events.ts";
import { jobRepository } from "../repositories/jobs.ts";
import type { JobQueue } from "../queue/service.ts";
import { finishScanIfComplete } from "../scans/finalize.ts";
import { runDecomposition } from "./decomposition.ts";
import { runFix } from "./fix.ts";
import {
  createCommentOnPullRequest,
  createDiagnosticIssue,
  createFinalizeIssue,
  executeRole,
  readResponseFile,
  removeResponseFile,
  safeError,
  terminalEvent,
} from "./helpers.ts";
import { runImplementation } from "./implementation.ts";
import { runReview } from "./review.ts";
import type { RunnerContext, RunnerGitHub, RunningJob, SessionState } from "./types.ts";

type RunnerDependencies = {
  config: Config;
  provider?: AgentProvider;
  providers?: Partial<Record<AgentProvider["name"], AgentProvider>>;
  github: RunnerGitHub;
  events?: EventService;
  queue?: Pick<JobQueue, "enqueue">;
  createWorktree?: typeof createTargetWorktree;
  createReviewWorktree?: typeof createTargetReviewWorktree;
  removeWorktree?: typeof removeTargetWorktree;
  gcRepository?: typeof gcRepository;
  heartbeatIntervalMs?: number;
};

export function createJobRunner({
  config,
  provider: defaultProvider,
  providers,
  github,
  events = { record: eventRepository.create, notifyQueuedSummary: async () => {} },
  queue = { enqueue: async () => {} },
  createWorktree = createTargetWorktree,
  createReviewWorktree = createTargetReviewWorktree,
  removeWorktree = removeTargetWorktree,
  gcRepository: gc = gcRepository,
  heartbeatIntervalMs,
}: RunnerDependencies) {
  async function run(jobId: string, workerId: string) {
    const job = await jobRepository.findRunning(jobId, workerId);
    if (!job) return false;
    const provider = (providers?.[job.provider.toLowerCase() as AgentProvider["name"]] ?? defaultProvider) as AgentProvider;

    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.AGENT_TIMEOUT_MS)]);
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatStopped = false;
    const heartbeatOnce = async () => {
      if (heartbeatStopped) return;
      try {
        const active = await jobRepository.heartbeat(job.id, workerId);
        if (!active) controller.abort(new Error("Job is no longer running"));
      } finally {
        if (!heartbeatStopped) {
          heartbeatTimer = setTimeout(() => void heartbeatOnce(), heartbeatIntervalMs ?? config.HEARTBEAT_INTERVAL_MS);
        }
      }
    };
    void heartbeatOnce();

    let reachedTerminalState = false;
    const state: SessionState = { worktreeCreated: false };
    try {
      if (!provider) throw new Error(`No provider configured for ${job.provider}`);
      const context: RunnerContext = {
        config,
        github,
        events,
        queue,
        createWorktree,
        createReviewWorktree,
        job,
        provider,
        signal,
        state,
        executeRoleWithRetry: createExecuteRoleWithRetry(events, config, provider),
        finalizeIssue: createFinalizeIssue(github, config, events),
        commentOnPullRequest: createCommentOnPullRequest(github, events),
      };
      const flow = {
        IMPLEMENTATION: runImplementation,
        FIX: runFix,
        REVIEW: runReview,
        DECOMPOSITION: runDecomposition,
      }[job.jobType];
      await flow(context);
      reachedTerminalState = true;
    } catch (error) {
      const message = safeError(error);
      reachedTerminalState = await jobRepository.finishRunning(job.id, "FAILED", { errorMessage: message });
      if (reachedTerminalState) {
        await events.record({
          ...terminalEvent(job, "JOB_FAILED", message),
          level: "ERROR",
        });
        await reportFailure(job, error, state);
      }
    } finally {
      heartbeatStopped = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (state.worktreeCreated) {
        try {
          await removeWorktree({
            worktreePath: state.worktreePath!,
            repositoryPath: state.repositoryPath,
            gitEnvironment: githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl),
          });
        } catch (error) {
          await events.record({
            type: "GITHUB_RECONCILIATION_REQUIRED",
            level: "ERROR",
            message: `Could not remove job worktree ${state.worktreePath}: ${safeError(error)}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            scanRunId: job.scanRunId ?? undefined,
            metadata: { issueUrl: job.issueUrl },
          });
        }
      }
      if (state.repositoryPath) {
        try {
          await gc({ repositoryPath: state.repositoryPath, gitEnvironment: githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl) });
        } catch {
          // gc is best-effort; leave the local clone untouched on failure
        }
      }
      await finishScanIfComplete(job.scanRunId, job.environment, events);
    }
    return reachedTerminalState;
  }

  async function reportFailure(job: RunningJob, error: unknown, state: SessionState) {
    const diagnosticIssue = config.CREATE_DIAGNOSTIC_ISSUES
      ? await createDiagnosticIssue(github, config, job, error, state.activePullRequest)
      : undefined;
    const comment = [
      `Worker failed: ${safeError(error)}`,
      config.CREATE_DIAGNOSTIC_ISSUES
        ? diagnosticIssue ? `\nDiagnostic issue: ${diagnosticIssue.url}` : "\nThe diagnostic issue could not be created automatically."
        : undefined,
    ].filter((line): line is string => line !== undefined).join("\n");
    await createFinalizeIssue(github, config, events)(job, [config.ISSUE_BLOCKED_LABEL], comment);
    if (state.activePullRequest) {
      try {
        await github.addIssueComment(
          job.repository.fullName,
          state.activePullRequest.number,
          `## Swarmloom job failure\n\n${comment}`,
        );
      } catch {
        // the diagnostic issue and job history already carry the evidence
      }
    }
  }

  return { run };
}

function createExecuteRoleWithRetry(events: EventService, config: Config, provider: AgentProvider) {
  return async function executeRoleWithRetry(
    role: Parameters<typeof executeRole>[1],
    task: string,
    context: string,
    parse: (response: string) => void,
    workingDirectory: string,
    abortSignal: AbortSignal,
    currentJob: RunningJob,
  ) {
    let guidance: string | undefined;
    for (let attempt = 0; ; attempt++) {
      const result = await executeRole(
        { config, provider, events },
        role,
        task,
        attempt === 0 ? context : `${context}${guidance}`,
        workingDirectory,
        abortSignal,
        currentJob,
      );
      if (result.exitCode !== 0) return { ...result, response: "" };
      try {
        const response = await readResponseFile(result.responseFilePath);
        parse(response);
        return { ...result, response };
      } catch (error) {
        if (attempt >= 1) throw error;
        guidance = `\n\nYour previous response was not accepted: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        await removeResponseFile(result.responseFilePath);
      }
    }
  };
}

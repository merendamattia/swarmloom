import type { Prisma } from "@prisma/client";
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
import { runDecomposition } from "./decomposition.ts";
import { runFix } from "./fix.ts";
import {
  createCommentOnPullRequest,
  createFinalizeIssue,
  executeRole,
  readResponseFile,
  removeResponseFile,
  safeError,
  terminalEvent,
} from "./helpers.ts";
import { runImplementation } from "./implementation.ts";
import { runReview } from "./review.ts";
import { createSupportIssue } from "../support-issues/service.ts";
import { AgentExecutionError, executionFailure, isQuotaFailure, minimalDiagnostics, type JobDiagnostics, type RoleExecution } from "./diagnostics.ts";
import type { RunnerContext, RunnerGitHub, RunningJob, SessionState } from "./types.ts";
import { quotaAdmission } from "../providers/quota.ts";

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
  const diagnosticEnvironment = { ...globalThis.process.env, SWARMLOOM_GITHUB_TOKEN: config.GITHUB_TOKEN };

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
    let retainWorktree = false;
    let worktreeCleanupComplete = false;
    const state: SessionState = {
      worktreeCreated: Boolean(job.worktreePath),
      worktreePersisted: Boolean(job.worktreePath),
      worktreePath: job.worktreePath ?? undefined,
      repositoryPath: job.worktreePath ? job.repository.localPath ?? undefined : undefined,
    };
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
        executeRoleWithRetry: createExecuteRoleWithRetry(events, config, provider, (execution) => {
          state.lastExecution = execution;
        }),
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
      if (isQuotaFailure(error)) {
        const admission = quotaAdmission(error.failure.quota);
        const paused = await jobRepository.waitForQuotaRunning(job.id, job.environment, workerId, {
          resetAt: admission.kind === "wait" ? admission.resetAt : null,
          window: admission.kind === "wait" ? admission.window : null,
          usedPercent: admission.kind === "wait" ? admission.usedPercent : null,
          message: error.failure.message,
          diagnostics: error.diagnostics as Prisma.InputJsonValue,
          sessionId: error.diagnostics.sessionId,
          exitCode: error.diagnostics.exitCode,
        });
        if (paused) {
          state.preserveWorktree = true;
          await events.record({
            type: "JOB_WAITING_FOR_QUOTA",
            message: `Paused ${job.repository.fullName}#${job.issueNumber} until Codex quota returns`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            scanRunId: job.scanRunId ?? undefined,
            metadata: {
              quotaResetAt: admission.kind === "wait" ? admission.resetAt : null,
              quotaWindow: admission.kind === "wait" ? admission.window : null,
              quotaUsedPercent: admission.kind === "wait" ? admission.usedPercent : null,
              observedAt: error.failure.quota.observedAt,
            },
          });
        }
      } else {
        const message = safeError(error);
        const diagnostics = error instanceof AgentExecutionError
          ? error.diagnostics
          : state.lastExecution
            ? executionFailure(
              roleStage(state.lastExecution.role),
              state.lastExecution.role,
              job,
              provider,
              state.lastExecution,
              error,
              { environment: diagnosticEnvironment },
            ).diagnostics
            : minimalDiagnostics(error, { provider: provider?.name ?? "unconfigured", model: job.model }, diagnosticEnvironment);
        reachedTerminalState = await jobRepository.finishRunning(job.id, "FAILED", {
          errorMessage: message,
          diagnostics: diagnostics as Prisma.InputJsonValue,
        });
        retainWorktree = reachedTerminalState && state.worktreePersisted && Boolean(state.worktreePath);
        if (reachedTerminalState) {
          await events.record({
            ...terminalEvent(job, "JOB_FAILED", message),
            level: "ERROR",
          });
          await reportFailure(job, error, state);
        }
      }
    } finally {
      heartbeatStopped = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      const preserveWorktree = state.preserveWorktree || retainWorktree;
      if (state.worktreeCreated && !preserveWorktree) {
        try {
          await removeWorktree({
            worktreePath: state.worktreePath!,
            repositoryPath: state.repositoryPath,
            gitEnvironment: githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl),
          });
          await jobRepository.clearWorktree(job.id);
          worktreeCleanupComplete = true;
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
      if (state.repositoryPath && !preserveWorktree) {
        try {
          await gc({ repositoryPath: state.repositoryPath, gitEnvironment: githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl) });
        } catch {
          // gc is best-effort; leave the local clone untouched on failure
        }
      }
      if (!state.worktreeCreated || preserveWorktree) worktreeCleanupComplete = true;
      if (worktreeCleanupComplete) await jobRepository.releaseWorker(job.id, workerId);
    }
    return reachedTerminalState;
  }

  async function reportFailure(job: RunningJob, error: unknown, state: SessionState) {
    const diagnosticResult = config.CREATE_DIAGNOSTIC_ISSUES
      ? await createSupportIssue({ config, github, jobId: job.id, environment: job.environment, origin: "automatic" })
      : undefined;
    const diagnosticIssue = diagnosticResult?.kind === "created" || diagnosticResult?.kind === "existing" ? diagnosticResult.issue : undefined;
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

function createExecuteRoleWithRetry(events: EventService, config: Config, provider: AgentProvider, onExecution: (execution: RoleExecution) => void) {
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
    const resumeSessionId = currentJob.sessionId ?? undefined;
    for (let attempt = 0; ; attempt++) {
      const result = await executeRole(
        { config, provider, events },
        role,
        task,
        attempt === 0 ? context : `${context}${guidance}`,
        workingDirectory,
        abortSignal,
        currentJob,
        resumeSessionId,
      );
      onExecution(result);
      if (result.exitCode !== 0) return result;
      let response = "";
      try {
        response = await readResponseFile(result.responseFilePath);
        parse(response);
        const completed = { ...result, response };
        onExecution(completed);
        return completed;
      } catch (error) {
        if (attempt >= 1) {
          throw executionFailure("parser", role, currentJob, provider, result, error, { finalOutput: response || result.finalOutput, environment: { ...globalThis.process.env, SWARMLOOM_GITHUB_TOKEN: config.GITHUB_TOKEN } });
        }
        guidance = `\n\nYour previous response was not accepted: ${safeError(error)}`;
      } finally {
        await removeResponseFile(result.responseFilePath);
      }
    }
  };
}
function roleStage(role: RoleExecution["role"]): JobDiagnostics["stage"] {
  return role === "issue-worker" ? "implementation" : role === "decomposer" ? "decomposition" : "review";
}

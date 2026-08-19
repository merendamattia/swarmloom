import type { Prisma } from "@prisma/client";
import { dirname, resolve, sep } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { Config } from "../core/config-schema.ts";
import { redactSecrets } from "../core/secrets.ts";
import type { EventService } from "../events/service.ts";
import {
  createJobWorktree as createTargetWorktree,
  createReviewWorktree as createTargetReviewWorktree,
  gcRepository,
  removeJobWorktree as removeTargetWorktree,
} from "../git/repositories.ts";
import type { GitHubClient, GitHubIssueContext } from "../github/client.ts";
import { githubGitEnvironment } from "../github/git-auth.ts";
import { replaceWorkerLabels } from "../github/labels.ts";
import type { AgentProvider, AgentResult, AgentRole } from "../providers/index.ts";
import { ProviderProcessError } from "../providers/process.ts";
import { eventRepository } from "../repositories/events.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { reviewRepository } from "../repositories/reviews.ts";
import { loadAgentInstructions } from "../runtime/instructions.ts";
import { finishScanIfComplete } from "../scans/finalize.ts";
import {
  AgentExecutionError,
  causeChain,
  minimalDiagnostics,
  tail,
  type DiagnosticEvent,
  type JobDiagnostics,
} from "./diagnostics.ts";
import {
  parseJobOutcome,
  parsePullRequestUrl,
  parseReviewOutcome,
} from "./response.ts";

type RunnerGitHub = Pick<GitHubClient,
  "getIssue" | "getIssueContext" | "getPullRequest" | "getPullRequestDiff" |
  "createIssue" | "setIssueLabels" | "addIssueComment">;

type CreateWorktree = typeof createTargetWorktree;
type CreateReviewWorktree = typeof createTargetReviewWorktree;
type RemoveWorktree = typeof removeTargetWorktree;
type GcRepository = typeof gcRepository;
type RunningJob = NonNullable<Awaited<ReturnType<typeof jobRepository.findRunning>>>;
type ReviewFollowUp = { branchName: string; pullRequestNumber?: number };
type RoleExecution = AgentResult & { response: string; responseFilePath: string; events: DiagnosticEvent[] };

type RunnerDependencies = {
  config: Config;
  provider?: AgentProvider;
  providers?: Partial<Record<AgentProvider["name"], AgentProvider>>;
  github: RunnerGitHub;
  events?: EventService;
  createWorktree?: CreateWorktree;
  createReviewWorktree?: CreateReviewWorktree;
  removeWorktree?: RemoveWorktree;
  gcRepository?: GcRepository;
  heartbeatIntervalMs?: number;
};

export function createJobRunner({
  config,
  provider: defaultProvider,
  providers,
  github,
  events = { record: eventRepository.create, notifyQueuedSummary: async () => {} },
  createWorktree = createTargetWorktree,
  createReviewWorktree = createTargetReviewWorktree,
  removeWorktree = removeTargetWorktree,
  gcRepository: gc = gcRepository,
  heartbeatIntervalMs,
}: RunnerDependencies) {
  async function run(jobId: string, workerId: string) {
    const job = await jobRepository.findRunning(jobId, workerId);
    if (!job) return false;
    const selectedProvider: AgentProvider | undefined = providers?.[job.provider.toLowerCase() as AgentProvider["name"]] ?? defaultProvider;
    const provider = selectedProvider as AgentProvider;

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
    let liveContext: GitHubIssueContext | undefined;
    let followUp: ReviewFollowUp | undefined;
    let activePullRequest: { number: number; url: string } | undefined;
    let worktreePath: string | undefined;
    let worktreeCreated = false;
    let repositoryPath: string | undefined;
    try {
      if (!selectedProvider) throw new Error(`No provider configured for ${job.provider}`);
      liveContext = await github.getIssueContext(job.repository.fullName, job.issueNumber, job.issueUrl);
      followUp =
        liveContext.issue.labels.includes(config.ISSUE_REVIEW_REQUESTED_LABEL) && liveContext.pullRequests[0]
          ? { branchName: liveContext.pullRequests[0].head, pullRequestNumber: liveContext.pullRequests[0].number }
          : undefined;
      if (!job.repository.localPath) throw new Error("Repository has no synchronized local path");
      const localPath = job.repository.localPath;
      worktreePath = safeWorktreePath(config.DATA_DIR, job.id);
      const gitEnvironment = githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl);
      if (followUp) {
        await createReviewWorktree({
          repositoryPath: localPath,
          worktreePath,
          branchName: followUp.branchName,
          gitEnvironment,
        });
      } else {
        await createWorktree({
          repositoryPath: localPath,
          worktreePath,
          branchName: job.branchName,
          baselineCommit: job.baselineCommit,
          gitEnvironment,
        });
      }
      worktreeCreated = true;
      if (!await jobRepository.setWorktree(job.id, worktreePath)) return false;
      repositoryPath = localPath;
      await events.record({
        type: "JOB_STARTED",
        message: `${followUp ? "Follow-up on" : "Started"} ${job.repository.fullName}#${job.issueNumber} · ${job.issueTitle}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, provider: provider.name, model: job.model },
      });

      const implementation = await executeRoleWithRetry(
        "issue-worker",
        `Process ${job.repository.fullName}#${job.issueNumber}: ${job.issueTitle}`,
        issueContext(job, config.ISSUE_REVIEW_REQUESTED_LABEL, liveContext, followUp),
        (response) => { parseJobOutcome(response); },
        worktreePath,
        signal,
        job,
      );
      await jobRepository.setImplementationResult(job.id, implementation.sessionId, implementation.exitCode);
      if (implementation.exitCode !== 0) {
        throw failure("implementation", "issue-worker", job, provider, implementation,
          implementation.stderr || `${provider.name} exited with ${implementation.exitCode}`);
      }
      let outcome = parseJobOutcome(implementation.response);
      if (outcome === "requires_decomposition") {
        const decomposition = await executeRoleWithRetry(
          "decomposer",
          `Decompose ${job.repository.fullName}#${job.issueNumber} into coherent native sub-issues`,
          `${issueContext(job, config.ISSUE_REVIEW_REQUESTED_LABEL, liveContext, followUp)}\nQueue-ready label for actionable children: ${config.ISSUE_READY_LABEL}`,
          (response) => {
            const parsed = parseJobOutcome(response);
            if (parsed !== "decomposed" && parsed !== "blocked") {
              throw new Error("Decomposer returned an unsupported outcome");
            }
          },
          worktreePath,
          signal,
          job,
        );
        if (decomposition.exitCode !== 0) {
          throw failure("decomposition", "decomposer", job, provider, decomposition,
            decomposition.stderr || `${provider.name} decomposer exited unsuccessfully`);
        }
        outcome = parseJobOutcome(decomposition.response);
      }

      if (outcome === "implemented") {
        const { review, pullRequestUrl, pullRequest, response } = await reviewImplementation(job, implementation.response, worktreePath, signal);
        reachedTerminalState = await jobRepository.finishRunning(job.id, "COMPLETED", {
          result: response,
          exitCode: implementation.exitCode,
          pullRequestNumber: pullRequest.number,
          pullRequestUrl,
        });
        if (reachedTerminalState) {
          await events.record({
            type: "JOB_COMPLETED",
            message: `Completed ${job.repository.fullName}#${job.issueNumber} with PR #${pullRequest.number} using ${provider.name}/${job.model} in ${duration(job.startedAt)}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            scanRunId: job.scanRunId ?? undefined,
            metadata: {
              issueUrl: job.issueUrl,
              pullRequestUrl,
              pullRequestNumber: pullRequest.number,
              pullRequestTitle: pullRequest.title,
              pullRequestBody: pullRequest.body,
              filesChanged: pullRequest.changedFiles,
              additions: pullRequest.additions,
              deletions: pullRequest.deletions,
              provider: provider.name,
              model: job.model,
            },
          });
          const nextLabel = review.verdict === "changes_requested"
            ? config.ISSUE_REVIEW_REQUESTED_LABEL
            : config.ISSUE_COMPLETED_LABEL;
          await finalizeIssue(job, [nextLabel], response);
          await postReview(job.repository.fullName, pullRequest.number, review.response);
        }
      } else if (outcome === "blocked") {
        reachedTerminalState = await jobRepository.finishRunning(job.id, "BLOCKED", {
          result: implementation.response,
          exitCode: implementation.exitCode,
        });
        if (reachedTerminalState) {
          await events.record(terminalEvent(job, "JOB_BLOCKED", "Worker blocked"));
          await finalizeIssue(job, [config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL], implementation.response);
        }
      } else if (outcome === "decomposed") {
        reachedTerminalState = await jobRepository.finishRunning(job.id, "DECOMPOSED", {
          result: implementation.response,
          exitCode: implementation.exitCode,
        });
        if (reachedTerminalState) {
          await events.record(terminalEvent(job, "JOB_DECOMPOSED", "Worker decomposed the issue"));
          await finalizeIssue(job, [config.ISSUE_DECOMPOSED_LABEL], implementation.response);
        }
      }
    } catch (error) {
      const message = safeError(error);
      const currentDiagnostics = error instanceof AgentExecutionError
        ? error.diagnostics
        : minimalDiagnostics(error, { provider: provider?.name ?? "unconfigured", model: job.model });
      reachedTerminalState = await jobRepository.finishRunning(job.id, "FAILED", {
        errorMessage: message,
        diagnostics: jsonValue(currentDiagnostics),
      });
      if (reachedTerminalState) {
        await events.record({
          ...terminalEvent(job, "JOB_FAILED", message),
          level: "ERROR",
        });
        await reportFailure(job, error, activePullRequest);
      }
    } finally {
      heartbeatStopped = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (worktreeCreated) {
        try {
          await removeWorktree({ worktreePath: worktreePath!, repositoryPath, gitEnvironment: githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl) });
        } catch (error) {
          await events.record({
            type: "GITHUB_RECONCILIATION_REQUIRED",
            level: "ERROR",
            message: `Could not remove job worktree ${worktreePath}: ${safeError(error)}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            scanRunId: job.scanRunId ?? undefined,
            metadata: { issueUrl: job.issueUrl },
          });
        }
      }
      if (repositoryPath) {
        try {
          await gc({ repositoryPath, gitEnvironment: githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl) });
        } catch {
          // gc is best-effort; leave the local clone untouched on failure
        }
      }
      await finishScanIfComplete(job.scanRunId, job.environment, events);
    }
    return reachedTerminalState;

    async function executeRoleWithRetry(
      role: AgentRole,
      task: string,
      context: string,
      parse: (response: string) => void,
      workingDirectory: string,
      abortSignal: AbortSignal,
      currentJob: RunningJob,
    ): Promise<Awaited<ReturnType<typeof executeRole>>> {
      let guidance: string | undefined;
      for (let attempt = 0; ; attempt++) {
        const result = await executeRole(role, task, attempt === 0 ? context : `${context}${guidance}`, workingDirectory, abortSignal, currentJob);
        if (result.exitCode !== 0) return result;
        try {
          parse(result.response);
          return result;
        } catch (error) {
          if (attempt >= 1) {
            throw failure("parser", role, currentJob, provider, result, error, { finalOutput: result.response });
          }
          guidance = `\n\nYour previous response was not accepted: ${safeError(error)}`;
        }
      }
    }

    async function executeRole(
      role: AgentRole,
      task: string,
      context: string,
      workingDirectory: string,
      abortSignal: AbortSignal,
      currentJob: RunningJob,
    ): Promise<RoleExecution> {
      const responseFilePath = responseFilePathFor(config.DATA_DIR, currentJob.id, role);
      await mkdir(dirname(responseFilePath), { recursive: true });
      const diagnosticEvents: DiagnosticEvent[] = [];
      try {
        let result: AgentResult;
        try {
          result = await provider.execute({
            role,
            workingDirectory,
            task,
            context,
            instructions: await loadAgentInstructions(config.AGENT_RUNTIME_DIR),
            model: currentJob.model,
            reasoningEffort: currentJob.reasoningEffort as Config["CODEX_REASONING_EFFORT"] | undefined,
            responseFilePath,
            signal: abortSignal,
            onEvent: async (agentEvent) => {
              diagnosticEvents.push({
                type: agentEvent.type,
                timestamp: agentEvent.timestamp,
                message: agentEvent.message ? redactSecrets(agentEvent.message).slice(0, 8_000) : undefined,
                tool: agentEvent.tool,
              });
              await events.record({
                type: agentEvent.type === "AGENT_OUTPUT" ? "AGENT_OUTPUT" : `AGENT_${agentEvent.type}`,
                message: (agentEvent.message || agentEvent.type).slice(0, 8_000),
                jobId: currentJob.id,
                repositoryId: currentJob.repositoryId,
                scanRunId: currentJob.scanRunId ?? undefined,
                metadata: agentEvent.metadata as Prisma.InputJsonValue | undefined,
              });
            },
          });
        } catch (error) {
          throw new AgentExecutionError(safeError(error), {
            stage: error instanceof ProviderProcessError ? "provider_process" : roleStage(role),
            role,
            provider: provider.name,
            model: currentJob.model,
            sessionId: null,
            exitCode: error instanceof ProviderProcessError ? error.exitCode : null,
            error: safeError(error),
            causeChain: causeChain(error),
            stderr: error instanceof ProviderProcessError ? error.stderr : undefined,
            events: diagnosticEvents,
          });
        }
        if (result.exitCode !== 0) {
          return { ...result, responseFilePath, response: "", events: diagnosticEvents };
        }
        return { ...result, responseFilePath, response: await readResponseFile(responseFilePath), events: diagnosticEvents };
      } finally {
        await removeResponseFile(responseFilePath);
      }
    }

    async function reviewImplementation(
      currentJob: RunningJob,
      implementationResponse: string,
      workingDirectory: string,
      abortSignal: AbortSignal,
    ) {
      const pullRequestUrl = parsePullRequestUrl(implementationResponse);
      if (!pullRequestUrl) {
        throw new Error('Implemented agent response must include a "PR: <url>" line');
      }
      const pullRequestNumber = Number(/\/pull\/(\d+)/.exec(pullRequestUrl)?.[1]);
      const pullRequest = await github.getPullRequest(currentJob.repository.fullName, pullRequestNumber);
      activePullRequest = { number: pullRequest.number, url: pullRequest.url };
      const expectedHead = followUp?.branchName ?? currentJob.branchName;
      if (pullRequest.base !== "develop" || pullRequest.head !== expectedHead) {
        throw new Error(`PR #${pullRequest.number} must use ${expectedHead} -> develop`);
      }
      if (!pullRequest.body.includes(`#${currentJob.issueNumber}`)
        && !pullRequest.body.includes(currentJob.issueUrl)) {
        throw new Error(`PR #${pullRequest.number} is not linked to issue #${currentJob.issueNumber}`);
      }
      await events.record({
        type: "PR_OPENED",
        message: followUp
          ? `Updated PR #${pullRequest.number} for ${currentJob.repository.fullName}#${currentJob.issueNumber}`
          : `Opened PR #${pullRequest.number} for ${currentJob.repository.fullName}#${currentJob.issueNumber}`,
        jobId: currentJob.id,
        repositoryId: currentJob.repositoryId,
        scanRunId: currentJob.scanRunId ?? undefined,
        metadata: {
          issueUrl: currentJob.issueUrl,
          pullRequestUrl: pullRequest.url,
          pullRequestNumber: pullRequest.number,
          pullRequestTitle: pullRequest.title,
          pullRequestBody: pullRequest.body,
          filesChanged: pullRequest.changedFiles,
          additions: pullRequest.additions,
          deletions: pullRequest.deletions,
        },
      });
      const diff = await github.getPullRequestDiff(currentJob.repository.fullName, pullRequest.number);
      const reviewRow = await reviewRepository.start(
        currentJob.id,
        currentJob.provider,
        currentJob.model,
        currentJob.reasoningEffort,
      );
      try {
        const result = await executeRoleWithRetry(
          "reviewer",
          `Independently review ${pullRequest.url}`,
          `${issueContext(currentJob, config.ISSUE_REVIEW_REQUESTED_LABEL, liveContext, followUp)}\n\nPull Request: ${JSON.stringify(pullRequest)}\n\nDiff from develop:\n${diff}`,
          (response) => { parseReviewOutcome(response); },
          workingDirectory,
          abortSignal,
          currentJob,
        );
        if (result.exitCode !== 0) throw failure("review", "reviewer", currentJob, provider, result, result.stderr || "Automated review failed");
        const reviewResponse = result.response;
        const verdict = parseReviewOutcome(reviewResponse);
        await reviewRepository.finish(
          reviewRow.id,
          verdict === "pass" ? "PASSED" : "CHANGES_REQUESTED",
          {
            sessionId: result.sessionId,
            response: reviewResponse,
            exitCode: result.exitCode,
          },
        );
        await events.record({
          type: "REVIEW_COMPLETED",
          message: `Review ${verdict} for ${currentJob.repository.fullName}#${pullRequest.number}`,
          jobId: currentJob.id,
          repositoryId: currentJob.repositoryId,
          scanRunId: currentJob.scanRunId ?? undefined,
          metadata: {
            issueUrl: currentJob.issueUrl,
            pullRequestUrl: pullRequest.url,
            verdict,
          },
        });
        return { review: { verdict, response: reviewResponse }, pullRequestUrl: pullRequest.url, pullRequest, response: implementationResponse };
      } catch (error) {
        await reviewRepository.finish(reviewRow.id, "FAILED", { errorMessage: safeError(error) });
        throw error;
      }
    }

    async function reportFailure(
      currentJob: RunningJob,
      error: unknown,
      pullRequest: { number: number; url: string } | undefined,
    ) {
      const details = failureDetails(error, config.GITHUB_TOKEN);
      const diagnosticBody = [
        "## Swarmloom job failure",
        `Original issue: ${currentJob.issueUrl}`,
        pullRequest ? `Pull Request: ${pullRequest.url}` : undefined,
        `Job ID: ${currentJob.id}`,
        "",
        "### Error and stack trace",
        "```text",
        details,
        "```",
        "",
        "Fix the root cause, add or update regression coverage, and leave the issue ready for another worker pass.",
      ].filter((line): line is string => line !== undefined).join("\n");
      let diagnosticIssue: { number: number; url: string } | undefined;
      try {
        diagnosticIssue = await github.createIssue(
          currentJob.repository.fullName,
          `[Swarmloom] Fix failed job for ${currentJob.repository.fullName}#${currentJob.issueNumber}`,
          diagnosticBody,
          [config.ISSUE_READY_LABEL],
        );
      } catch (creationError) {
        await recordGithubFailure(currentJob, "create diagnostic issue", creationError);
      }

      const comment = [
        `Worker failed: ${safeError(error)}`,
        diagnosticIssue ? `\nDiagnostic issue: ${diagnosticIssue.url}` : "\nThe diagnostic issue could not be created automatically.",
      ].filter((line): line is string => line !== undefined).join("\n");
      await finalizeIssue(
        currentJob,
        [],
        comment,
      );
      if (pullRequest) {
        try {
          await github.addIssueComment(
            currentJob.repository.fullName,
            pullRequest.number,
            `## Swarmloom job failure\n\n${comment}`,
          );
        } catch (commentError) {
          await recordGithubFailure(currentJob, `comment on Pull Request #${pullRequest.number}`, commentError);
        }
      }
    }

    async function finalizeIssue(currentJob: RunningJob, labels: string[], comment: string) {
      try {
        const issue = await github.getIssue(currentJob.repository.fullName, currentJob.issueNumber);
        await github.setIssueLabels(
          currentJob.repository.fullName,
          currentJob.issueNumber,
          replaceWorkerLabels(issue.labels, config, labels),
        );
      } catch (error) {
        await recordGithubFailure(currentJob, "update issue labels", error);
      }
      try {
        await github.addIssueComment(currentJob.repository.fullName, currentJob.issueNumber, comment);
      } catch (error) {
        await recordGithubFailure(currentJob, "comment on issue", error);
      }
    }

    async function recordGithubFailure(currentJob: RunningJob, action: string, error: unknown) {
      await events.record({
        type: "GITHUB_RECONCILIATION_REQUIRED",
        level: "ERROR",
        message: `Could not ${action} for ${currentJob.repository.fullName}#${currentJob.issueNumber}: ${safeError(error)}`,
        jobId: currentJob.id,
        repositoryId: currentJob.repositoryId,
        scanRunId: currentJob.scanRunId ?? undefined,
        metadata: { issueUrl: currentJob.issueUrl },
      });
    }

    async function postReview(fullName: string, pullRequestNumber: number, review: string) {
      try {
        await github.addIssueComment(fullName, pullRequestNumber, review);
      } catch (error) {
        await events.record({
          type: "GITHUB_RECONCILIATION_REQUIRED",
          level: "ERROR",
          message: `Could not post automated review to ${fullName}#${pullRequestNumber}: ${safeError(error)}`,
          jobId: (job as RunningJob).id,
          repositoryId: (job as RunningJob).repositoryId,
          scanRunId: (job as RunningJob).scanRunId ?? undefined,
          metadata: { issueUrl: (job as RunningJob).issueUrl },
        });
      }
    }
  }

  return { run };
}

function safeWorktreePath(dataDirectory: string, jobId: string) {
  const root = resolve(dataDirectory, "worktrees");
  const path = resolve(root, jobId);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("Job worktree path escapes data directory");
  return path;
}

function responseFilePathFor(dataDirectory: string, jobId: string, role: AgentRole) {
  const root = resolve(dataDirectory, "outcomes");
  const path = resolve(root, `${jobId}-${role}.txt`);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("Response file path escapes data directory");
  return path;
}

async function readResponseFile(path: string) {
  const file = Bun.file(path);
  if (!await file.exists()) {
    throw new Error(`Agent finished without writing the response to ${path}`);
  }
  const content = await file.text();
  if (!content.trim()) {
    throw new Error(`Agent wrote an empty response to ${path}`);
  }
  return content;
}

async function removeResponseFile(path: string) {
  await rm(path, { force: true });
}

function issueContext(job: {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueBody: string;
  baselineCommit: string;
  branchName: string;
}, reviewRequestedLabel: string, liveContext?: GitHubIssueContext, followUp?: ReviewFollowUp) {
  const mode = followUp
    ? `Mode: review follow-up. Continue branch ${followUp.branchName}${followUp.pullRequestNumber ? ` in pull request #${followUp.pullRequestNumber}` : ""}. Fix the files to address the requested changes, verify locally, and push to ${followUp.branchName} so the already-open pull request updates. Do not create a new branch or a new pull request.`
    : "Mode: fresh implementation. Create a new branch and open a pull request targeting develop.";
  return [
    `Issue: #${job.issueNumber} ${job.issueTitle}`,
    `URL: ${job.issueUrl}`,
    `Baseline: ${followUp ? `origin/${followUp.branchName}` : `origin/develop at ${job.baselineCommit}`}`,
    `Assigned branch: ${followUp?.branchName ?? job.branchName}`,
    mode,
    `Review retry label: ${reviewRequestedLabel}. If the issue currently carries it, this job addresses an existing review and must work on the already-open pull request.`,
    `Body:\n${job.issueBody}`,
    liveContext && `Issue labels: ${liveContext.issue.labels.join(", ") || "none"}`,
    liveContext && `Live GitHub context fetched before execution:\n${redactSecrets(JSON.stringify(liveContext, null, 2))}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function terminalEvent(
  job: { id: string; repositoryId: string; scanRunId: string | null; issueUrl: string },
  type: string,
  message: string,
) {
  return {
    type,
    message,
    jobId: job.id,
    repositoryId: job.repositoryId,
    scanRunId: job.scanRunId ?? undefined,
    metadata: { issueUrl: job.issueUrl },
  };
}

function safeError(error: unknown) {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function roleStage(role: AgentRole): JobDiagnostics["stage"] {
  return role === "issue-worker" ? "implementation" : role === "decomposer" ? "decomposition" : "review";
}

function failure(
  stage: JobDiagnostics["stage"],
  role: AgentRole | null,
  job: { model: string },
  provider: AgentProvider,
  result: RoleExecution,
  error: unknown,
  extra: { cause?: unknown; finalOutput?: string; stderr?: string } = {},
) {
  const message = error instanceof Error ? error.message : String(error);
  return new AgentExecutionError(safeError(message), {
    stage,
    role,
    provider: provider.name,
    model: job.model,
    sessionId: result.sessionId,
    exitCode: result.exitCode,
    error: safeError(message),
    causeChain: causeChain(extra.cause ?? error),
    stderr: extra.stderr ?? (result.stderr || undefined),
    finalOutput: (() => {
      const raw = extra.finalOutput
        ?? (result.response.trim() ? result.response : result.finalOutput.trim() ? result.finalOutput : undefined);
      return raw ? tail(redactSecrets(raw), 20_000) : undefined;
    })(),
    events: result.events,
  });
}

function jsonValue(value: unknown) {
  return value as Prisma.InputJsonValue;
}

function failureDetails(error: unknown, githubToken: string) {
  const text = error instanceof Error ? `${error.message}\n\nStack trace:\n${error.stack ?? "Unavailable"}` : String(error);
  return redactSecrets(redactSecrets(text), {
    ...globalThis.process.env,
    GITHUB_TOKEN: githubToken,
  }).slice(0, 12_000);
}

function duration(startedAt: Date | null) {
  if (!startedAt) return "an unknown duration";
  const seconds = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1_000));
  return `${seconds}s`;
}

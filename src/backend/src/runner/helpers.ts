import type { Prisma } from "@prisma/client";
import { dirname, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { redactSecrets } from "../core/secrets.ts";
import type { Config } from "../core/config-schema.ts";
import { githubGitEnvironment } from "../github/git-auth.ts";
import { replacePullRequestLabels, replaceWorkerLabels } from "../github/labels.ts";
import { loadAgentInstructions } from "../runtime/instructions.ts";
import type { AgentRole } from "../providers/index.ts";
import type { AgentTokenUsage } from "../providers/types.ts";
import { ProviderProcessError } from "../providers/process.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { AgentExecutionError, causeChain, executionFailure, stackTrace, type DiagnosticEvent, type JobDiagnostics } from "./diagnostics.ts";
import type { GitHubIssueContext } from "../github/client.ts";
import type { RunningJob, RunnerContext, RunnerGitHub } from "./types.ts";
import { parseJobOutcome, parsePullRequestUrl, parseReviewOutcome, parseTldr } from "./response.ts";

export function responseFilePathFor(dataDirectory: string, jobId: string, role: AgentRole) {
  const root = resolve(dataDirectory, "outcomes");
  const path = resolve(root, `${jobId}-${role}.txt`);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("Response file path escapes data directory");
  return path;
}

export async function readResponseFile(path: string) {
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

export async function removeResponseFile(path: string) {
  await rm(path, { force: true });
}

export async function prepareJobWorktree(
  job: RunningJob,
  defaultPath: string,
  create: () => Promise<void>,
) {
  if (job.worktreePath) {
    if (!existsSync(job.worktreePath)) {
      throw new Error(`Persisted worktree is missing for job ${job.id}: ${job.worktreePath}`);
    }
    return { path: job.worktreePath, created: false };
  }
  await create();
  return { path: defaultPath, created: true };
}

export async function executeRole(
  context: Pick<RunnerContext, "config" | "provider" | "events">,
  role: AgentRole,
  task: string,
  contextText: string,
  workingDirectory: string,
  abortSignal: AbortSignal,
  job: RunningJob,
  resumeSessionId?: string,
) {
  const responseFilePath = responseFilePathFor(context.config.DATA_DIR, job.id, role);
  await mkdir(dirname(responseFilePath), { recursive: true });
  const diagnosticEvents: DiagnosticEvent[] = [];
  const requestedSessionId = resumeSessionId;
  let sessionId: string | null = null;
  let usagePersistenceFailureRecorded = false;
  const persistUsage = async (usage: AgentTokenUsage) => {
    try {
      await jobRepository.setTokenUsage(job.id, usage, job.claimToken);
    } catch {
      if (usagePersistenceFailureRecorded) return;
      usagePersistenceFailureRecorded = true;
      await context.events.record({
        type: "AGENT_USAGE_PERSISTENCE_FAILED",
        level: "WARNING",
        message: "Could not persist provider token usage; execution continues without this telemetry",
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl },
      }).catch(() => {});
    }
  };
  let resumedEventRecorded = false;
  try {
    await removeResponseFile(responseFilePath);
    const result = await context.provider.execute({
      role,
      workingDirectory,
      task,
      context: contextText,
      instructions: await loadAgentInstructions(context.config.AGENT_RUNTIME_DIR),
      model: job.model,
      reasoningEffort: job.reasoningEffort ?? undefined,
      resumeSessionId: requestedSessionId ?? undefined,
      environment: githubGitEnvironment(context.config.GITHUB_TOKEN, job.repository.cloneUrl),
      responseFilePath,
      signal: abortSignal,
      onUsage: persistUsage,
      onEvent: async (agentEvent) => {
        if (!await jobRepository.isActiveClaim(job.id, job.workerId, job.claimToken)) return;
        if (agentEvent.type === "SESSION_STARTED" && typeof agentEvent.metadata?.sessionId === "string") {
          const observedSessionId = agentEvent.metadata.sessionId;
          if (requestedSessionId && observedSessionId !== requestedSessionId) {
            throw new Error(`Provider resumed session ${observedSessionId} instead of requested ${requestedSessionId}`);
          }
          sessionId = observedSessionId;
          if (!await jobRepository.setSessionId(job.id, job.claimToken, observedSessionId)) {
            throw new Error(`Could not persist provider session for job ${job.id}`);
          }
          job.sessionId = observedSessionId;
        }
        diagnosticEvents.push({
          type: agentEvent.type,
          timestamp: agentEvent.timestamp,
          message: agentEvent.message ? redactSecrets(agentEvent.message).slice(0, 8_000) : undefined,
          tool: agentEvent.tool,
        });
        await context.events.record({
          type: agentEvent.type === "AGENT_OUTPUT" ? "AGENT_OUTPUT" : `AGENT_${agentEvent.type}`,
          message: (agentEvent.message || agentEvent.type).slice(0, 8_000),
          jobId: job.id,
          repositoryId: job.repositoryId,
          scanRunId: job.scanRunId ?? undefined,
          metadata: {
            ...agentEvent.metadata,
            attempt: job.attempts,
            sessionResumed: Boolean(requestedSessionId),
          } as Prisma.InputJsonValue,
        });
        if (requestedSessionId && agentEvent.type === "SESSION_STARTED") {
          await context.events.record({
            type: "SESSION_RESUMED",
            message: `Resumed provider session ${requestedSessionId}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            scanRunId: job.scanRunId ?? undefined,
            metadata: { attempt: job.attempts, sessionId: requestedSessionId },
          });
          resumedEventRecorded = true;
        }
      },
    });
    const resolvedSessionId = sessionId ?? result.sessionId;
    if (requestedSessionId && resolvedSessionId && resolvedSessionId !== requestedSessionId) {
      throw new Error(`Provider returned session ${resolvedSessionId} instead of requested ${requestedSessionId}`);
    }
    if (sessionId && result.sessionId && result.sessionId !== sessionId) {
      throw new Error(`Provider returned session ${result.sessionId} after starting session ${sessionId}`);
    }
    if (requestedSessionId && !resolvedSessionId) {
      throw new Error(result.stderr || `Provider did not resume session ${requestedSessionId}`);
    }
    if (resolvedSessionId && !sessionId) {
      if (!await jobRepository.setSessionId(job.id, job.claimToken, resolvedSessionId)) {
        throw new Error(`Could not persist provider session for job ${job.id}`);
      }
      sessionId = resolvedSessionId;
      job.sessionId = resolvedSessionId;
    }
    if (requestedSessionId && !resumedEventRecorded) {
      await context.events.record({
        type: "SESSION_RESUMED",
        message: `Resumed provider session ${requestedSessionId}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { attempt: job.attempts, sessionId: requestedSessionId },
      });
    }
    const execution = {
      ...result,
      role,
      sessionId: resolvedSessionId,
      responseFilePath,
      response: "",
      events: diagnosticEvents,
    };
    if (result.usage) await persistUsage(result.usage);
    if (result.failure) {
      throw executionFailure(
        roleStage(role),
        role,
        job,
        context.provider,
        execution,
        new Error(result.failure.message),
        {
          failure: result.failure,
          finalOutput: result.finalOutput,
          stderr: result.stderr,
          environment: { ...globalThis.process.env, SWARMLOOM_GITHUB_TOKEN: context.config.GITHUB_TOKEN },
        },
      );
    }
    return execution;
  } catch (error) {
    await removeResponseFile(responseFilePath);
    if (error instanceof AgentExecutionError) throw error;
    throw new AgentExecutionError(safeError(error), {
      stage: error instanceof ProviderProcessError ? "provider_process" : roleStage(role),
      role,
      provider: context.provider.name,
      model: job.model,
      sessionId,
      exitCode: error instanceof ProviderProcessError ? error.exitCode : null,
      error: safeError(error),
      causeChain: causeChain(error),
      stack: stackTrace(error, { ...globalThis.process.env, SWARMLOOM_GITHUB_TOKEN: context.config.GITHUB_TOKEN }),
      stderr: error instanceof ProviderProcessError ? error.stderr : undefined,
      events: diagnosticEvents,
    });
  }
}


export function implementationContext(
  job: RunningJob,
  liveContext?: GitHubIssueContext,
) {
  return [
    `Issue: #${job.issueNumber} ${job.issueTitle}`,
    `URL: ${job.issueUrl}`,
    "Trusted originating issue metadata (the only source for PR issue references):",
    `- Repository full name: ${job.repository.fullName}`,
    `- Numeric issue number: ${job.issueNumber}`,
    `Canonical same-repository PR reference: \`Closes #${job.issueNumber}\``,
    "For same-repository PRs, use this reference; do not copy issue URLs from sanitized live context.",
    `Baseline: origin/develop at ${job.baselineCommit}`,
    `Assigned branch: ${job.branchName}`,
    job.sessionId || job.worktreePath
      ? "Mode: resume the existing durable implementation from its current workspace. Continue the existing work and open or update the pull request as appropriate."
      : "Mode: fresh implementation. Create a new branch and open a pull request targeting develop.",
    "Markdown PR body requirement: use real newline characters for headings, lists, and section separators. Build the body with `--body-file` from a temporary file or quoted heredoc; never pass literal `\\n` sequences for line breaks. Verify the created body with `gh pr view <number> --json body --template '{{.body}}' | sed -n 'l'`.",
    `Body:\n${job.issueBody}`,
    recoveryContext(job),
    liveContext && `Issue labels: ${liveContext.issue.labels.join(", ") || "none"}`,
    liveContext && `Live GitHub context fetched before execution:\n${redactSecrets(JSON.stringify(liveContext, null, 2))}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function fixContext(
  job: RunningJob,
  liveContext: GitHubIssueContext,
  reason: string,
  details?: string | null,
) {
  const pullRequest = liveContext.pullRequests[0];
  return [
    `Issue: #${job.issueNumber} ${job.issueTitle}`,
    `URL: ${job.issueUrl}`,
    `Pull Request: ${pullRequest?.url ?? job.pullRequestUrl} (#${job.pullRequestNumber})`,
    `Pull Request branch: ${pullRequest?.head ?? job.branchName}`,
    "Mode: fix existing pull request. Work on the already-open pull request branch, address the failure below, verify locally, and push to that same remote branch so the open pull request updates. Do not create a new branch or a new pull request.",
    recoveryContext(job),
    `Fix reason: ${reason}`,
    details && `Fix details:\n${details}`,
    `Body:\n${job.issueBody}`,
    `Issue labels: ${liveContext.issue.labels.join(", ") || "none"}`,
    `Live GitHub context fetched before execution:\n${redactSecrets(JSON.stringify(liveContext, null, 2))}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function reviewContext(
  job: RunningJob,
  liveContext: GitHubIssueContext,
  diff: string,
) {
  const pullRequest = liveContext.pullRequests[0];
  return [
    `Issue: #${job.issueNumber} ${job.issueTitle}`,
    `URL: ${job.issueUrl}`,
    `Pull Request: ${pullRequest?.url ?? job.pullRequestUrl}`,
    `Head SHA under review: ${job.headSha ?? "unknown"}`,
    recoveryContext(job),
    "Reproduce the repository CI locally before deciding the verdict. Treat any failing CI command as review evidence, diagnose its root cause, and return actionable changes_requested feedback for the fix worker.",
    `Pull Request:\n${redactSecrets(JSON.stringify(pullRequest, null, 2))}`,
    `Diff from develop:\n${diff}`,
    `Body:\n${job.issueBody}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function decompositionContext(
  job: RunningJob,
  liveContext?: GitHubIssueContext,
  readyLabel?: string,
) {
  return [
    `Issue: #${job.issueNumber} ${job.issueTitle}`,
    `URL: ${job.issueUrl}`,
    `Baseline: origin/develop at ${job.baselineCommit}`,
    "Mode: decomposition. Split the issue into coherent native sub-issues and create each child as a GitHub sub-issue of the parent. Do not open pull requests or edit repository files.",
    recoveryContext(job),
    readyLabel && `Queue-ready label for actionable children: ${readyLabel}`,
    `Body:\n${job.issueBody}`,
    liveContext && `Issue labels: ${liveContext.issue.labels.join(", ") || "none"}`,
    liveContext && `Live GitHub context fetched before execution:\n${redactSecrets(JSON.stringify(liveContext, null, 2))}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function recoveryContext(job: Pick<RunningJob, "sessionId" | "worktreePath">) {
  if (!job.sessionId && !job.worktreePath) return undefined;
  return [
    "Recovery: Continue this durable job from the current workspace. Do not repeat completed repository inspection or discard existing filesystem progress.",
    job.sessionId
      ? `The provider must resume the persisted session ${job.sessionId}.`
      : "No provider session was persisted; start a new session in the retained workspace.",
    job.worktreePath && `Retained workspace: ${job.worktreePath}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function createFinalizeIssue(github: RunnerGitHub, config: Config, events: RunnerContext["events"]) {
  return async function finalizeIssue(job: RunningJob, labels: string[], comment: string) {
    try {
      const issue = await github.getIssue(job.repository.fullName, job.issueNumber);
      await github.setIssueLabels(
        job.repository.fullName,
        job.issueNumber,
        replaceWorkerLabels(issue.labels, config, labels),
      );
    } catch (error) {
      await recordGithubFailure(events, job, "update issue labels", error);
    }
    try {
      await github.addIssueComment(job.repository.fullName, job.issueNumber, comment);
    } catch (error) {
      await recordGithubFailure(events, job, "comment on issue", error);
    }
  };
}

export function createCommentOnPullRequest(github: RunnerGitHub, events: RunnerContext["events"]) {
  return async function commentOnPullRequest(job: RunningJob, pullRequestNumber: number, comment: string) {
    try {
      await github.addIssueComment(job.repository.fullName, pullRequestNumber, comment);
    } catch (error) {
      await recordGithubFailure(events, job, `comment on pull request #${pullRequestNumber}`, error);
    }
  };
}

export async function recordGithubFailure(
  events: RunnerContext["events"],
  job: RunningJob,
  action: string,
  error: unknown,
) {
  await events.record({
    type: "GITHUB_RECONCILIATION_REQUIRED",
    level: "ERROR",
    message: `Could not ${action} for ${job.repository.fullName}#${job.issueNumber}: ${safeError(error)}`,
    jobId: job.id,
    repositoryId: job.repositoryId,
    scanRunId: job.scanRunId ?? undefined,
    metadata: { issueUrl: job.issueUrl },
  });
}

export async function applyPullRequestLabels(
  github: RunnerGitHub,
  config: Config,
  job: RunningJob,
  pullRequestNumber: number,
  nextLabels: string[],
  canWrite?: () => Promise<boolean>,
) {
  const labels = await github.getPullRequestLabels(job.repository.fullName, pullRequestNumber);
  if (canWrite && !await canWrite()) return false;
  await github.setPullRequestLabels(
    job.repository.fullName,
    pullRequestNumber,
    replacePullRequestLabels(labels, config, nextLabels),
  );
  return true;
}

export function terminalEvent(
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

function roleStage(role: AgentRole): JobDiagnostics["stage"] {
  return role === "issue-worker" ? "implementation" : role === "decomposer" ? "decomposition" : "review";
}

export function safeError(error: unknown) {

  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

export { parseJobOutcome, parsePullRequestUrl, parseReviewOutcome, parseTldr };

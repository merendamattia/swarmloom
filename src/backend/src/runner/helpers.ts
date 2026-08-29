import type { Prisma } from "@prisma/client";
import { dirname, resolve, sep } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { redactSecrets } from "../core/secrets.ts";
import type { Config } from "../core/config-schema.ts";
import { githubGitEnvironment } from "../github/git-auth.ts";
import { replacePullRequestLabels, replaceWorkerLabels } from "../github/labels.ts";
import { loadAgentInstructions } from "../runtime/instructions.ts";
import type { AgentRole } from "../providers/index.ts";
import { ProviderProcessError } from "../providers/process.ts";
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
export async function executeRole(
  context: Pick<RunnerContext, "config" | "provider" | "events">,
  role: AgentRole,
  task: string,
  contextText: string,
  workingDirectory: string,
  abortSignal: AbortSignal,
  job: RunningJob,
) {
  const responseFilePath = responseFilePathFor(context.config.DATA_DIR, job.id, role);
  await mkdir(dirname(responseFilePath), { recursive: true });
  const diagnosticEvents: DiagnosticEvent[] = [];
  let sessionId: string | null = null;
  try {
    const result = await context.provider.execute({
      role,
      workingDirectory,
      task,
      context: contextText,
      instructions: await loadAgentInstructions(context.config.AGENT_RUNTIME_DIR),
      model: job.model,
      reasoningEffort: job.reasoningEffort as Config["CODEX_CODING_REASONING_EFFORT"] | undefined,
      sessionId: job.implementationSessionId,
      environment: githubGitEnvironment(context.config.GITHUB_TOKEN, job.repository.cloneUrl),
      responseFilePath,
      signal: abortSignal,
      onEvent: async (agentEvent) => {
        if (agentEvent.type === "SESSION_STARTED" && typeof agentEvent.metadata?.sessionId === "string") {
          sessionId = agentEvent.metadata.sessionId;
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
          metadata: agentEvent.metadata as Prisma.InputJsonValue | undefined,
        });
      },
    });
    const execution = {
      ...result,
      role,
      sessionId: sessionId ?? result.sessionId ?? job.implementationSessionId,
      responseFilePath,
      response: "",
      events: diagnosticEvents,
    };
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
    "Mode: fresh implementation. Create a new branch and open a pull request targeting develop.",
    "Markdown PR body requirement: use real newline characters for headings, lists, and section separators. Build the body with `--body-file` from a temporary file or quoted heredoc; never pass literal `\\n` sequences for line breaks. Verify the created body with `gh pr view <number> --json body --template '{{.body}}' | sed -n 'l'`.",
    `Body:\n${job.issueBody}`,
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
    readyLabel && `Queue-ready label for actionable children: ${readyLabel}`,
    `Body:\n${job.issueBody}`,
    liveContext && `Issue labels: ${liveContext.issue.labels.join(", ") || "none"}`,
    liveContext && `Live GitHub context fetched before execution:\n${redactSecrets(JSON.stringify(liveContext, null, 2))}`,
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
) {
  const labels = await github.getPullRequestLabels(job.repository.fullName, pullRequestNumber);
  await github.setPullRequestLabels(
    job.repository.fullName,
    pullRequestNumber,
    replacePullRequestLabels(labels, config, nextLabels),
  );
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

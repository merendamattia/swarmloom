import type { Prisma } from "@prisma/client";
import { resolve, sep } from "node:path";
import type { Config } from "../core/config-schema.ts";
import { redactSecrets } from "../core/secrets.ts";
import type { EventService } from "../events/service.ts";
import { createJobWorktree as createTargetWorktree } from "../git/repositories.ts";
import type { GitHubClient } from "../github/client.ts";
import { githubGitEnvironment } from "../github/git-auth.ts";
import { replaceWorkerLabels } from "../github/labels.ts";
import type { AgentProvider, AgentRole } from "../providers/index.ts";
import { eventRepository } from "../repositories/events.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { reviewRepository } from "../repositories/reviews.ts";
import { loadAgentInstructions, resultSchemaPath } from "../runtime/instructions.ts";
import { finishScanIfComplete } from "../scans/finalize.ts";
import { parseJobOutcome, parseReviewOutcome, type JobOutcome, type ReviewOutcome } from "./outcomes.ts";

type RunnerGitHub = Pick<GitHubClient,
  "getIssue" | "getPullRequest" | "getPullRequestDiff" | "setIssueLabels" | "addIssueComment">;

type CreateWorktree = typeof createTargetWorktree;
type RunningJob = NonNullable<Awaited<ReturnType<typeof jobRepository.findRunning>>>;

type RunnerDependencies = {
  config: Config;
  provider?: AgentProvider;
  providers?: Partial<Record<AgentProvider["name"], AgentProvider>>;
  github: RunnerGitHub;
  events?: EventService;
  createWorktree?: CreateWorktree;
  heartbeatIntervalMs?: number;
};

export function createJobRunner({
  config,
  provider: defaultProvider,
  providers,
  github,
  events = { record: eventRepository.create },
  createWorktree = createTargetWorktree,
  heartbeatIntervalMs,
}: RunnerDependencies) {
  async function run(jobId: string, workerId: string) {
    const job = await jobRepository.findRunning(jobId, workerId);
    if (!job) return false;
    const selectedProvider: AgentProvider | undefined = providers?.[job.provider.toLowerCase() as AgentProvider["name"]] ?? defaultProvider;
    if (!selectedProvider) throw new Error(`No provider configured for ${job.provider}`);
    const provider = selectedProvider;

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
    try {
      if (!job.repository.localPath) throw new Error("Repository has no synchronized local path");
      const worktreePath = safeWorktreePath(config.DATA_DIR, job.id);
      await createWorktree({
        repositoryPath: job.repository.localPath,
        worktreePath,
        branchName: job.branchName,
        baselineCommit: job.baselineCommit,
        gitEnvironment: githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl),
      });
      if (!await jobRepository.setWorktree(job.id, worktreePath)) return false;
      await events.record({
        type: "JOB_STARTED",
        message: `Started ${job.repository.fullName}#${job.issueNumber}`,
        jobId: job.id,
        repositoryId: job.repositoryId,
        scanRunId: job.scanRunId ?? undefined,
        metadata: { issueUrl: job.issueUrl, provider: provider.name, model: job.model },
      });

      const implementation = await executeRole(
        "issue-worker",
        `Process ${job.repository.fullName}#${job.issueNumber}: ${job.issueTitle}`,
        issueContext(job),
        worktreePath,
        signal,
        job,
      );
      await jobRepository.setImplementationResult(job.id, implementation.sessionId, implementation.exitCode);
      if (implementation.exitCode !== 0) {
        throw new Error(implementation.stderr || `${provider.name} exited with ${implementation.exitCode}`);
      }
      let outcome = parseJobOutcome(implementation.finalOutput);
      if (outcome.outcome === "requires_decomposition") {
        const decomposition = await executeRole(
          "decomposer",
          `Decompose ${job.repository.fullName}#${job.issueNumber} into coherent native sub-issues`,
          `${issueContext(job)}\nQueue-ready label for actionable children: ${config.ISSUE_READY_LABEL}\n\nReason from triage:\n${outcome.reason}`,
          worktreePath,
          signal,
          job,
        );
        if (decomposition.exitCode !== 0) {
          throw new Error(decomposition.stderr || `${provider.name} decomposer exited unsuccessfully`);
        }
        outcome = parseJobOutcome(decomposition.finalOutput);
        if (outcome.outcome !== "decomposed" && outcome.outcome !== "blocked") {
          throw new Error("Decomposer returned an unsupported outcome");
        }
      }

      if (outcome.outcome === "implemented") {
        const { review, pullRequestUrl } = await reviewImplementation(job, outcome, worktreePath, signal);
        reachedTerminalState = await jobRepository.finishRunning(job.id, "COMPLETED", {
          result: jsonValue({ ...outcome, pr: { ...outcome.pr, url: pullRequestUrl }, review }),
          exitCode: implementation.exitCode,
          pullRequestNumber: outcome.pr.number,
          pullRequestUrl,
        });
        if (reachedTerminalState) {
          await events.record({
            type: "JOB_COMPLETED",
            message: `Completed ${job.repository.fullName}#${job.issueNumber} with PR #${outcome.pr.number} using ${provider.name}/${job.model} in ${duration(job.startedAt)}`,
            jobId: job.id,
            repositoryId: job.repositoryId,
            scanRunId: job.scanRunId ?? undefined,
            metadata: {
              issueUrl: job.issueUrl,
              pullRequestUrl,
              provider: provider.name,
              model: job.model,
              review: review.verdict,
            },
          });
          await finalizeIssue(job, [config.ISSUE_COMPLETED_LABEL],
            `Implemented in ${pullRequestUrl}. Automated review: **${review.verdict}** — ${review.summary}`);
          await postReview(job.repository.fullName, outcome.pr.number, review);
        }
      } else if (outcome.outcome === "blocked") {
        reachedTerminalState = await jobRepository.finishRunning(job.id, "BLOCKED", {
          result: jsonValue(outcome),
          exitCode: implementation.exitCode,
        });
        if (reachedTerminalState) {
          await events.record(terminalEvent(job, "JOB_BLOCKED", outcome.summary));
          await finalizeIssue(job, [config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL],
            `Worker blocked: ${outcome.summary}\n\nRequired information: ${outcome.question}`);
        }
      } else if (outcome.outcome === "decomposed") {
        reachedTerminalState = await jobRepository.finishRunning(job.id, "DECOMPOSED", {
          result: jsonValue(outcome),
          exitCode: implementation.exitCode,
        });
        if (reachedTerminalState) {
          await events.record(terminalEvent(job, "JOB_DECOMPOSED", outcome.summary));
          await finalizeIssue(job, [config.ISSUE_DECOMPOSED_LABEL],
            `Worker decomposed this issue into: ${outcome.childIssues.map((child) => `#${child.number}`).join(", ")}.`);
        }
      } else {
        throw new Error("Issue worker returned an unresolved decomposition request");
      }
    } catch (error) {
      const message = safeError(error);
      reachedTerminalState = await jobRepository.finishRunning(job.id, "FAILED", { errorMessage: message });
      if (reachedTerminalState) {
        await events.record({
          ...terminalEvent(job, "JOB_FAILED", message),
          level: "ERROR",
        });
        await finalizeIssue(job, [], `Worker failed: ${message}`);
      }
    } finally {
      heartbeatStopped = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      await finishScanIfComplete(job.scanRunId, job.environment, events);
    }
    return reachedTerminalState;

    async function executeRole(
      role: AgentRole,
      task: string,
      context: string,
      workingDirectory: string,
      abortSignal: AbortSignal,
      currentJob: RunningJob,
    ) {
      const schemaPath = resultSchemaPath(config.AGENT_RUNTIME_DIR, role);
      return provider.execute({
        role,
        workingDirectory,
        task,
        context,
        instructions: await loadAgentInstructions(config.AGENT_RUNTIME_DIR),
        artifacts: { "Required JSON schema": await Bun.file(schemaPath).text() },
        model: currentJob.model,
        reasoningEffort: currentJob.reasoningEffort as Config["CODEX_REASONING_EFFORT"] | undefined,
        outputSchemaPath: schemaPath,
        signal: abortSignal,
        onEvent: async (agentEvent) => {
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
    }

    async function reviewImplementation(
      currentJob: RunningJob,
      outcome: Extract<JobOutcome, { outcome: "implemented" }>,
      workingDirectory: string,
      abortSignal: AbortSignal,
    ) {
      const pullRequest = await github.getPullRequest(currentJob.repository.fullName, outcome.pr.number);
      if (pullRequest.base !== "develop" || pullRequest.head !== currentJob.branchName) {
        throw new Error(`PR #${pullRequest.number} must use ${currentJob.branchName} -> develop`);
      }
      if (!pullRequest.body.includes(`#${currentJob.issueNumber}`)
        && !pullRequest.body.includes(currentJob.issueUrl)) {
        throw new Error(`PR #${pullRequest.number} is not linked to issue #${currentJob.issueNumber}`);
      }
      await events.record({
        type: "PR_OPENED",
        message: `Opened PR #${pullRequest.number} for ${currentJob.repository.fullName}#${currentJob.issueNumber}`,
        jobId: currentJob.id,
        repositoryId: currentJob.repositoryId,
        scanRunId: currentJob.scanRunId ?? undefined,
        metadata: {
          issueUrl: currentJob.issueUrl,
          pullRequestUrl: pullRequest.url,
          pullRequestNumber: pullRequest.number,
        },
      });
      const diff = await github.getPullRequestDiff(currentJob.repository.fullName, outcome.pr.number);
      const reviewRow = await reviewRepository.start(
        currentJob.id,
        currentJob.provider,
        currentJob.model,
        currentJob.reasoningEffort,
      );
      try {
        const result = await executeRole(
          "reviewer",
          `Independently review ${pullRequest.url}`,
          `${issueContext(currentJob)}\n\nPull Request: ${JSON.stringify(pullRequest)}\nTests: ${outcome.tests.join(", ")}\n\nDiff from develop:\n${diff}`,
          workingDirectory,
          abortSignal,
          currentJob,
        );
        if (result.exitCode !== 0) throw new Error(result.stderr || "Automated review failed");
        const review = parseReviewOutcome(result.finalOutput);
        await reviewRepository.finish(
          reviewRow.id,
          review.verdict === "pass" ? "PASSED" : "CHANGES_REQUESTED",
          {
            sessionId: result.sessionId,
            verdict: jsonValue({ verdict: review.verdict, summary: review.summary }),
            findings: jsonValue(review.findings),
            exitCode: result.exitCode,
          },
        );
        await events.record({
          type: "REVIEW_COMPLETED",
          message: `Review ${review.verdict} for ${currentJob.repository.fullName}#${outcome.pr.number}`,
          jobId: currentJob.id,
          repositoryId: currentJob.repositoryId,
          scanRunId: currentJob.scanRunId ?? undefined,
          metadata: {
            issueUrl: currentJob.issueUrl,
            pullRequestUrl: pullRequest.url,
            verdict: review.verdict,
            findings: review.findings.length,
          },
        });
        return { review, pullRequestUrl: pullRequest.url };
      } catch (error) {
        await reviewRepository.finish(reviewRow.id, "FAILED", { errorMessage: safeError(error) });
        throw error;
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
        await github.addIssueComment(currentJob.repository.fullName, currentJob.issueNumber, comment);
      } catch (error) {
        await events.record({
          type: "GITHUB_RECONCILIATION_REQUIRED",
          level: "ERROR",
          message: `Could not finalize GitHub state for ${currentJob.repository.fullName}#${currentJob.issueNumber}: ${safeError(error)}`,
          jobId: currentJob.id,
          repositoryId: currentJob.repositoryId,
          scanRunId: currentJob.scanRunId ?? undefined,
          metadata: { issueUrl: currentJob.issueUrl },
        });
      }
    }

    async function postReview(fullName: string, pullRequestNumber: number, review: ReviewOutcome) {
      const findings = review.findings.map((finding) =>
        `- **${finding.severity}** ${finding.file}${finding.line ? `:${finding.line}` : ""}: ${finding.problem} Correction: ${finding.correction}`
      ).join("\n");
      try {
        await github.addIssueComment(fullName, pullRequestNumber,
          `## Automated review: ${review.verdict}\n\n${review.summary}${findings ? `\n\n${findings}` : ""}`);
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

function issueContext(job: {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueBody: string;
  baselineCommit: string;
  branchName: string;
}) {
  return [
    `Issue: #${job.issueNumber} ${job.issueTitle}`,
    `URL: ${job.issueUrl}`,
    `Baseline: origin/develop at ${job.baselineCommit}`,
    `Assigned branch: ${job.branchName}`,
    `Body:\n${job.issueBody}`,
  ].join("\n");
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

function jsonValue(value: unknown) {
  return value as Prisma.InputJsonValue;
}

function duration(startedAt: Date | null) {
  if (!startedAt) return "an unknown duration";
  const seconds = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1_000));
  return `${seconds}s`;
}

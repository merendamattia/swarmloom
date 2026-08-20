import { githubGitEnvironment } from "../github/git-auth.ts";
import { jobRepository } from "../repositories/jobs.ts";
import { safeWorktreePath } from "./paths.ts";
import {
  decompositionContext,
  parseJobOutcome,
} from "./helpers.ts";
import type { JobFlow } from "./types.ts";

export const runDecomposition: JobFlow = async (context) => {
  const { config, github, events, job, provider, signal } = context;
  const fullName = job.repository.fullName;
  context.state.liveContext = await github.getIssueContext(fullName, job.issueNumber, job.issueUrl);
  const liveContext = context.state.liveContext;

  if (!job.repository.localPath) throw new Error("Repository has no synchronized local path");
  const localPath = job.repository.localPath;
  const worktreePath = safeWorktreePath(config.DATA_DIR, job.id);
  const gitEnvironment = githubGitEnvironment(config.GITHUB_TOKEN, job.repository.cloneUrl);
  await context.createWorktree({
    repositoryPath: localPath,
    worktreePath,
    branchName: job.branchName,
    baselineCommit: job.baselineCommit,
    gitEnvironment,
  });
  context.state.worktreeCreated = true;
  context.state.worktreePath = worktreePath;
  context.state.repositoryPath = localPath;
  if (!await jobRepository.setWorktree(job.id, worktreePath)) return;

  await events.record({
    type: "JOB_STARTED",
    message: `Started DECOMPOSITION on ${fullName}#${job.issueNumber} · ${job.issueTitle}`,
    jobId: job.id,
    repositoryId: job.repositoryId,
    scanRunId: job.scanRunId ?? undefined,
    metadata: { issueUrl: job.issueUrl, provider: provider.name, model: job.model },
  });

  const decomposition = await context.executeRoleWithRetry(
    "decomposer",
    `Decompose ${fullName}#${job.issueNumber} into coherent native sub-issues`,
    decompositionContext(job, liveContext, config.ISSUE_READY_LABEL),
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
    throw new Error(decomposition.stderr || `${provider.name} decomposer exited unsuccessfully`);
  }
  const outcome = parseJobOutcome(decomposition.response);

  if (outcome === "decomposed") {
    const finished = await jobRepository.finishRunning(job.id, "DECOMPOSED", {
      result: decomposition.response,
      exitCode: decomposition.exitCode,
    });
    if (!finished) return;
    await events.record({
      type: "JOB_DECOMPOSED",
      message: `Worker decomposed ${fullName}#${job.issueNumber}`,
      jobId: job.id,
      repositoryId: job.repositoryId,
      scanRunId: job.scanRunId ?? undefined,
      metadata: { issueUrl: job.issueUrl },
    });
    await context.finalizeIssue(job, [config.ISSUE_DECOMPOSED_LABEL], decomposition.response);
    return;
  }

  const finished = await jobRepository.finishRunning(job.id, "BLOCKED", {
    result: decomposition.response,
    exitCode: decomposition.exitCode,
  });
  if (!finished) return;
  await events.record({
    type: "JOB_BLOCKED",
    message: "Worker blocked",
    jobId: job.id,
    repositoryId: job.repositoryId,
    scanRunId: job.scanRunId ?? undefined,
    metadata: { issueUrl: job.issueUrl },
  });
  await context.finalizeIssue(job, [config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL], decomposition.response);
};

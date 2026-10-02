import type { Config } from "../core/config-schema.ts";
import { logger } from "../core/logger.ts";
import { redactSecrets } from "../core/secrets.ts";
import type { GitHubClient } from "../github/client.ts";
import { replaceWorkerLabels } from "../github/labels.ts";
import { legacyDecompositionRepository } from "../repositories/legacy-decomposition.ts";

export async function reconcileLegacyDecompositionJobs(config: Config, github: GitHubClient) {
  const jobs = await legacyDecompositionRepository.findPending(config.APP_ENV);
  for (const job of jobs) {
    const token = await legacyDecompositionRepository.claim(job.id);
    if (!token) continue;
    try {
      const fullName = job.repository.fullName;
      const context = await github.getIssueContext(fullName, job.issueNumber, job.issueUrl);
      const labels = context.issue.labels;
      const blockedLabels = [config.ISSUE_BLOCKED_LABEL, config.ISSUE_HUMAN_REVIEW_LABEL];
      if (labels.includes(config.ISSUE_WORKING_LABEL)) {
        await github.setIssueLabels(fullName, job.issueNumber, replaceWorkerLabels(labels, config, blockedLabels));
      } else if (!blockedLabels.every((label) => labels.includes(label))) {
        // A person or another workflow already moved this issue; leave their state intact.
        await legacyDecompositionRepository.finish(job.id, token);
        continue;
      }

      const marker = `Legacy decomposition job: ${job.id}`;
      if (!context.issueComments.some((comment) => comment.body.includes(marker))) {
        await github.addIssueComment(
          fullName,
          job.issueNumber,
          `${marker}\n\nThe decomposition workflow was removed during this upgrade. This job stopped before completion, and the issue requires human intervention.`,
        );
      }
      await legacyDecompositionRepository.finish(job.id, token);
    } catch (error) {
      await legacyDecompositionRepository.release(job.id, token);
      logger.error("Could not reconcile legacy decomposition issue", {
        jobId: job.id,
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
    }
  }
}

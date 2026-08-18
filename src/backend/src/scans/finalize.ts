import type { EventService } from "../events/service.ts";
import { scanRunRepository } from "../repositories/scan-runs.ts";

export async function finishScanIfComplete(
  scanRunId: string | null,
  environment: string,
  events: EventService,
) {
  if (!scanRunId) return null;
  const scan = await scanRunRepository.finishJobs(scanRunId, environment);
  if (!scan) return null;
  const processed = scan.successCount + scan.failureCount + scan.blockedCount + scan.decomposedCount;
  await events.record({
    type: "SCAN_COMPLETED",
    message: `Scan completed in ${formatDuration(scan.durationMs)}: ${processed} processed, ${scan.successCount} succeeded, ${scan.failureCount} failed, ${scan.blockedCount} blocked, ${scan.decomposedCount} decomposed, ${scan.pullRequestsCount} PRs, ${scan.reviewsCount} reviews, ${scan.queueRemaining} queued`,
    scanRunId: scan.id,
    metadata: {
      processed,
      successes: scan.successCount,
      failures: scan.failureCount,
      blocked: scan.blockedCount,
      decomposed: scan.decomposedCount,
      pullRequests: scan.pullRequestsCount,
      reviews: scan.reviewsCount,
      queued: scan.queuedCount,
      queueRemaining: scan.queueRemaining,
      durationMs: scan.durationMs,
    },
  });
  return scan;
}

function formatDuration(durationMs: number | null) {
  return `${Math.max(0, Math.round((durationMs ?? 0) / 1_000))}s`;
}

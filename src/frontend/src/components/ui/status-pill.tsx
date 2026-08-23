import type { LucideIcon } from "lucide-react";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Clock3,
  LoaderCircle,
  Split,
  TriangleAlert,
} from "lucide-react";
import { statusLabel } from "@/lib/format";

type Tone = "neutral" | "active" | "success" | "warning" | "danger";

const states: Record<string, { tone: Tone; icon: LucideIcon }> = {
  QUEUED: { tone: "neutral", icon: Clock3 },
  RUNNING: { tone: "active", icon: LoaderCircle },
  COMPLETED: { tone: "success", icon: CircleCheck },
  IMPLEMENTED: { tone: "success", icon: CircleCheck },
  PASSED: { tone: "success", icon: CircleCheck },
  READY: { tone: "success", icon: CircleCheck },
  FAILED: { tone: "danger", icon: CircleX },
  ERROR: { tone: "danger", icon: CircleX },
  INVALID: { tone: "danger", icon: CircleX },
  STALE: { tone: "danger", icon: CircleAlert },
  BLOCKED: { tone: "warning", icon: TriangleAlert },
  CHANGES_REQUESTED: { tone: "warning", icon: TriangleAlert },
  DECOMPOSED: { tone: "neutral", icon: Split },
  REQUIRES_DECOMPOSITION: { tone: "warning", icon: TriangleAlert },
  CANCELLED: { tone: "neutral", icon: Ban },
  PENDING: { tone: "neutral", icon: CircleDashed },
  SKIPPED: { tone: "neutral", icon: CircleDashed },
};

export function StatusPill({ status }: { status: string }) {
  const state = states[status] ?? { tone: "neutral" as const, icon: CircleDot };
  const Icon = state.icon;
  return <span className="status-pill" data-tone={state.tone}><Icon aria-hidden="true" />{statusLabel(status)}</span>;
}

export function JobKindPill({ jobType }: { jobType: string }) {
  return <span className="kind-pill" data-kind={jobType.toLowerCase()}>{statusLabel(jobType)}</span>;
}

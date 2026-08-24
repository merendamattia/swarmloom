import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../../../");

const diagrams = [
  {
    alt: "Swarmloom issue-to-merge lifecycle",
    image: "docs/assets/swarmloom-lifecycle.svg",
    source: "docs/assets/swarmloom-lifecycle.mmd",
    requiredSource: [
      "flowchart LR",
      "issue([Issue<br/>agent:ready]) --> implementation[IMPLEMENTATION]",
      "implementation --> pullRequest([Pull request<br/>review-requested])",
      "pullRequest --> review[REVIEW<br/>exact head SHA]",
      "review -->|passes| reviewPassed([PR<br/>review-passed])",
      "reviewPassed --> readyToMerge([Issue<br/>ready-to-merge])",
      "readyToMerge --> humanMerge[Human merge]",
      "humanMerge --> done([Issue<br/>agent:done])",
      "review -->|changes requested| fixRequested([PR<br/>fix-requested])",
      "fixRequested --> fix[FIX<br/>same PR branch]",
      "fix -.->|review again| review",
    ],
  },
  {
    alt: "Swarmloom runtime architecture",
    image: "docs/assets/swarmloom-architecture.svg",
    source: "docs/assets/swarmloom-architecture.mmd",
    requiredSource: [
      "flowchart TB",
      "subgraph delivery[Delivery path]",
      "subgraph durable[Durable state and worker storage]",
      "subgraph surfaces[Operating surfaces]",
      "github([GitHub<br/>issues + PRs]) --> api[API + Scheduler<br/>reconcile]",
      "api --> queue[BullMQ + Redis<br/>deliver + lock]",
      "queue --> workers[Workers<br/>only executor]",
      "workers --> providers([Codex / OpenCode<br/>provider adapters])",
      "api -->|record state| postgres",
      "workers -->|guard claims| postgres",
      "workers -->|isolate work| worktrees",
      "dashboard -.->|reads API| api",
      "workers -.->|selected events| telegram",
    ],
  },
] as const;

describe("README diagrams", () => {
  test("reference rendered assets that stay synchronized with the final definitions", async () => {
    const readme = await Bun.file(resolve(repositoryRoot, "README.md")).text();

    expect(readme).not.toContain("```mermaid");

    for (const diagram of diagrams) {
      const source = await Bun.file(resolve(repositoryRoot, diagram.source)).text();
      const image = await Bun.file(resolve(repositoryRoot, diagram.image)).text();

      expect(readme).toContain(`![${diagram.alt}](${diagram.image})`);
      expect(image).toContain('<svg');
      expect(image).toContain('xmlns="http://www.w3.org/2000/svg"');

      for (const requiredLine of diagram.requiredSource) {
        expect(source).toContain(requiredLine);
      }

      const sourceHash = createHash("sha256").update(source).digest("hex");
      expect(image).toContain(`data-source-sha256="${sourceHash}"`);
    }
  });
});

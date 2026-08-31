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
] as const;

const architectureComponents = [
  { id: "github", label: "GitHub", sublabel: "Issues + pull requests" },
  { id: "dashboard", label: "Dashboard", sublabel: "Next.js reads the API" },
  { id: "api", label: "API", sublabel: "Hono routes + state access" },
  { id: "scheduler", label: "Scheduler + scanners", sublabel: "Cron reconciliation" },
  { id: "queue", label: "BullMQ + Redis/Valkey", sublabel: "Durable delivery + lock" },
  { id: "worker", label: "Workers + job runner", sublabel: "Only durable-job executor" },
  { id: "postgres", label: "PostgreSQL", sublabel: "Durable state + history" },
  { id: "worktrees", label: "Repository worktrees", sublabel: "Isolated worker storage" },
  { id: "providers", label: "Codex / OpenCode adapters", sublabel: "Shared AgentProvider contract" },
  { id: "telegram", label: "Telegram", sublabel: "Optional notifications" },
] as const;

const architectureConnections = [
  { from: "github", to: "scheduler", label: "reconcile issues + PRs" },
  { from: "scheduler", to: "queue", label: "enqueue discovered jobs" },
  { from: "api", to: "queue", label: "manual scans + retries" },
  { from: "queue", to: "worker", label: "deliver jobs" },
  { from: "worker", to: "github", label: "labels, comments + PRs" },
  { from: "worker", to: "providers", label: "execute through contract" },
  { from: "worker", to: "postgres", label: "guard claims + history" },
  { from: "worker", to: "worktrees", label: "isolate repository work" },
  { from: "api", to: "postgres", label: "read + record state" },
  { from: "dashboard", to: "api", label: "read operational state" },
  { from: "worker", to: "telegram", label: "selected events" },
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

  test("keeps the Archify architecture source and static SVG synchronized", async () => {
    const sourcePath = resolve(repositoryRoot, "docs/assets/swarmloom-architecture.archify.json");
    const imagePath = resolve(repositoryRoot, "docs/assets/swarmloom-architecture.svg");
    const sourceText = await Bun.file(sourcePath).text();
    const source = JSON.parse(sourceText) as {
      schema_version?: number;
      diagram_type?: string;
      meta?: { quality_profile?: string };
      components?: Array<{ id?: string; label?: string; sublabel?: string }>;
      connections?: Array<{ from?: string; to?: string; label?: string }>;
    };
    const image = await Bun.file(imagePath).text();

    expect(source.schema_version).toBe(1);
    expect(source.diagram_type).toBe("architecture");
    expect(source.meta?.quality_profile).toBe("showcase");
    expect(image).toContain('<svg');
    expect(image).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(image).toContain('data-quality-profile="showcase"');
    expect(image).not.toContain("<script");

    for (const componentDefinition of architectureComponents) {
      expect(source.components?.find(({ id }) => id === componentDefinition.id)).toMatchObject(componentDefinition);
      expect(image).toContain(`data-node-id="${componentDefinition.id}"`);
      expect(image).toContain(`data-node-label="${componentDefinition.label}"`);
    }

    for (const connection of architectureConnections) {
      expect(source.connections?.find(({ from, to }) => from === connection.from && to === connection.to)).toMatchObject(connection);
      expect(image).toContain(`data-edge-from="${connection.from}"`);
      expect(image).toContain(`data-edge-to="${connection.to}"`);
    }

    const sourceHash = createHash("sha256").update(sourceText).digest("hex");
    expect(image).toContain(`data-archify-source-sha256="${sourceHash}"`);
  });
});

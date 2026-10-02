import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../../../");

const diagrams = [
  {
    type: "lifecycle",
    alt: "Swarmloom issue-to-merge lifecycle",
    preview: "docs/assets/swarmloom-lifecycle-preview.png",
    source: "docs/diagrams/issue-to-merge.json",
    html: "docs/diagrams/issue-to-merge.html",
    nodeIds: ["issue-ready", "implementation", "review-requested", "review", "ready-to-merge", "fix-requested", "fix", "human-review", "done"],
  },
  {
    type: "architecture",
    alt: "Swarmloom runtime architecture",
    preview: "docs/assets/swarmloom-architecture-preview.png",
    source: "docs/diagrams/swarmloom-architecture.json",
    html: "docs/diagrams/swarmloom-architecture.html",
    nodeIds: ["dashboard", "control-plane", "github", "queue", "worker", "postgres", "worktrees", "providers"],
  },
] as const;

describe("README diagrams", () => {
  test("link static previews to self-contained, interactive Archify documents", async () => {
    const readme = await Bun.file(resolve(repositoryRoot, "README.md")).text();

    expect(readme).not.toContain("docs/assets/swarmloom-lifecycle.svg");
    expect(readme).not.toContain("docs/assets/swarmloom-architecture.svg");

    for (const diagram of diagrams) {
      const candidate = JSON.parse(await Bun.file(resolve(repositoryRoot, diagram.source)).text()) as {
        diagram_type?: string;
        meta?: { output?: string; quality_profile?: string; visual_preset?: string };
        components?: Array<{ id?: string }>;
        states?: Array<{ id?: string }>;
      };
      const html = await Bun.file(resolve(repositoryRoot, diagram.html)).text();
      const preview = new Uint8Array(await Bun.file(resolve(repositoryRoot, diagram.preview)).arrayBuffer());

      expect(readme).toContain(`[![${diagram.alt}](${diagram.preview})](${diagram.html})`);
      expect(readme).toContain(`(${diagram.html})`);
      expect([...preview.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(candidate.diagram_type).toBe(diagram.type);
      expect(candidate.meta).toMatchObject({
        output: diagram.html,
        quality_profile: "showcase",
        visual_preset: "signal-flow",
      });
      expect(html).toContain('<svg ');
      expect(html).toContain('data-preset="signal-flow"');
      expect(html).toContain('aria-label="Toggle color theme"');
      expect(html).toContain('aria-label="Export diagram"');
      expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)="https?:/i);

      for (const id of diagram.nodeIds) {
        expect(html).toContain(`data-node-id="${id}"`);
      }
    }
  });
});

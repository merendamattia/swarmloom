import { describe, expect, test } from "bun:test";

const frontendRoot = new URL("../../../", import.meta.url);

const source = async (path: string) => Bun.file(new URL(path, frontendRoot)).text();

describe("shared UI architecture", () => {
  test("keeps the product shell and repeated controls in components/ui", async () => {
    const components = [
      "src/components/ui/button.tsx",
      "src/components/ui/command-menu.tsx",
      "src/components/ui/confirm-dialog.tsx",
      "src/components/ui/dashboard-sidebar.tsx",
      "src/components/ui/empty-state.tsx",
      "src/components/ui/fact-list.tsx",
      "src/components/ui/field.tsx",
      "src/components/ui/page-header.tsx",
      "src/components/ui/panel.tsx",
      "src/components/ui/status-pill.tsx",
    ];

    for (const component of components) {
      expect(await Bun.file(new URL(component, frontendRoot)).exists(), component).toBe(true);
    }
  });

  test("routes delegate page sections to reusable domain components", async () => {
    const components = [
      "src/components/overview/system-health-card.tsx",
      "src/components/overview/exceptions-panel.tsx",
      "src/components/overview/active-job-panel.tsx",
      "src/components/jobs/job-filters.tsx",
      "src/components/jobs/job-facts.tsx",
      "src/components/settings/settings-section.tsx",
    ];

    for (const component of components) {
      expect(await Bun.file(new URL(component, frontendRoot)).exists(), component).toBe(true);
    }

    expect(await source("src/app/(app)/page.tsx")).toContain("@/components/overview/");
    expect(await source("src/app/(app)/jobs/page.tsx")).toContain("@/components/jobs/job-filters");
    expect(await source("src/app/(app)/jobs/[id]/page.tsx")).toContain("@/components/jobs/job-facts");
    expect(await source("src/app/(app)/settings/page.tsx")).toContain("@/components/settings/settings-editor");
  });

  test("routes consume shared components instead of restyling controls", async () => {
    const routes = [
      "src/app/(app)/page.tsx",
      "src/app/(app)/jobs/page.tsx",
      "src/app/(app)/jobs/[id]/page.tsx",
      "src/app/(app)/repositories/page.tsx",
      "src/app/(app)/settings/page.tsx",
    ];

    for (const route of routes) {
      const contents = await source(route);
      expect(contents, route).toContain("@/components/ui/");
      expect(contents, route).not.toContain('className="button');
      expect(contents, route).not.toContain('className="field');
      expect(contents, route).not.toContain('className="panel');
    }
  });

  test("the app shell uses the reusable dashboard sidebar", async () => {
    const contents = await source("src/components/app-shell.tsx");
    expect(contents).toContain("@/components/ui/dashboard-sidebar");
  });

  test("overview routes the five-job summary to the complete job history", async () => {
    const contents = await source("src/components/overview/overview-history.tsx");
    expect(contents).toContain('href="/jobs"');
    expect(contents).toContain("View all jobs");
  });

  test("repository job rows show provider and reasoning", async () => {
    const contents = await source("src/components/repositories/repository-card.tsx");
    expect(contents).toContain("statusLabel(job.provider)");
    expect(contents).toContain("job.reasoningEffort");
  });

  test("important actions use the shared confirmation dialog", async () => {
    const consumers = [
      "src/app/(app)/page.tsx",
      "src/components/repositories/repository-card.tsx",
    ];

    for (const consumer of consumers) {
      const contents = await source(consumer);
      expect(contents, consumer).toContain("@/components/ui/confirm-dialog");
      expect(contents, consumer).not.toContain("window.confirm");
    }
  });
});

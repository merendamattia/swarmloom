import { randomBytes } from "node:crypto";
import { createApp } from "../src/backend/src/api/app.ts";
import { config } from "../src/backend/src/core/config.ts";
import { prisma } from "../src/backend/src/core/db.ts";
import { createSettingsService } from "../src/backend/src/core/settings-service.ts";
import { createEventService } from "../src/backend/src/events/service.ts";
import { createGitHubClient } from "../src/backend/src/github/client.ts";

if (config.APP_ENV !== "test") throw new Error("Use an isolated test database and APP_ENV=test");

const app = createApp({
  config,
  startup: {
    database: "ok", dataDirectory: "/tmp", runtimeDirectory: config.AGENT_RUNTIME_DIR,
    gitVersion: "benchmark", ghVersion: "benchmark", provider: config.AGENT_PROVIDER,
    providerVersion: "benchmark", version: "benchmark",
  },
  scanner: { run: async () => { throw new Error("Benchmark only exercises job detail"); } },
  events: createEventService(),
  github: createGitHubClient({ token: config.GITHUB_TOKEN, apiUrl: config.GITHUB_API_URL }),
  settings: createSettingsService(config),
  scheduler: { restart() {} },
  queue: { health: async () => "PONG", enqueue: async () => {}, remove: async () => true },
});
const repository = await prisma.repository.create({ data: {
  fullName: `benchmark/${crypto.randomUUID()}`, cloneUrl: "https://github.com/benchmark/app.git",
} });
try {
  const job = await prisma.job.create({ data: {
    repositoryId: repository.id, environment: config.APP_ENV,
    issueNumber: 1, issueTitle: "Representative job history", issueUrl: "https://github.com/benchmark/app/issues/1",
    issueBody: "Benchmark", branchName: "agent/benchmark", baselineCommit: "a".repeat(40), provider: "CODEX", model: "test",
  } });
  await prisma.jobEvent.createMany({ data: Array.from({ length: 300 }, (_, index) => ({
    jobId: job.id, type: index % 10 === 0 ? "AGENT_OUTPUT" : "AGENT_TOOL_END",
    message: `Event ${index}: the implementation continues`,
    metadata: { tool: "shell", output: randomBytes(6144).toString("base64") },
    raw: { output: randomBytes(6144).toString("base64") },
    createdAt: new Date(1700000000000 + index),
  })) });
  const samples: number[] = [];
  let payloadBytes = 0;
  for (let index = 0; index < 25; index++) {
    const start = performance.now();
    const response = await app.request(`/api/jobs/${job.id}`);
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    payloadBytes = Buffer.byteLength(body);
    if (index >= 5) samples.push(performance.now() - start);
    if (JSON.parse(body).events.length !== 300) throw new Error("Timeline was truncated");
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({
    revision: process.argv[2], runtime: Bun.version, events: 300, payloadBytes,
    warmup: 5, samples: 20, p50Ms: samples[9], p95Ms: samples[18],
  }));
} finally {
  await prisma.job.deleteMany({ where: { repositoryId: repository.id } });
  await prisma.repository.delete({ where: { id: repository.id } });
  await prisma.$disconnect();
}

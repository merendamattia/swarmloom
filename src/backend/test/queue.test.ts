import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Queue, type Job } from "bullmq";
import IORedis from "ioredis";
import { createJobQueue, queueName, queuePayload, type QueuePayload } from "../src/queue/service.ts";

describe("job queue contract", () => {
  test("namespaces the queue by environment and carries no job payload secrets", () => {
    expect(queueName("test")).toBe("swarmloom-test-jobs");
    expect(queuePayload("job-123", "test")).toEqual({ jobId: "job-123", environment: "test" });
  });
});

const integration = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

integration("BullMQ delivery", () => {
  const environment = "test" as const;
  const durableJobId = crypto.randomUUID();
  let jobQueue: ReturnType<typeof createJobQueue>;
  let inspector: Queue<QueuePayload>;

  beforeAll(() => {
    const redisUrl = process.env.REDIS_URL ?? "redis://unused";
    jobQueue = createJobQueue({ APP_ENV: environment, REDIS_URL: redisUrl });
    inspector = new Queue<QueuePayload>(queueName(environment), {
      connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }),
      prefix: "swarmloom",
    });
  });

  afterAll(async () => {
    await jobQueue.close();
    await inspector.close();
  });

  test("enqueues repeated attempts as distinct deliveries for one durable job", async () => {
    await jobQueue.enqueue(durableJobId);
    await jobQueue.enqueue(durableJobId);

    const deliveries = (await inspector.getJobs(["waiting"])).filter((job: Job<QueuePayload>) => job.data.jobId === durableJobId);
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((job) => job.id))).toHaveLength(2);
    expect(deliveries.every((job) => job.id !== durableJobId)).toBe(true);

    await Promise.all(deliveries.map((job) => job.remove()));
  });
});

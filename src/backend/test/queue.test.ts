import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Queue, Worker, type Job } from "bullmq";
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

  test("keeps one live delivery for one durable job", async () => {
    await jobQueue.enqueue(durableJobId);
    await jobQueue.enqueue(durableJobId);

    const deliveries = (await inspector.getJobs(["waiting"])).filter((job: Job<QueuePayload>) => job.data.jobId === durableJobId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.id).not.toBe(durableJobId);

    await Promise.all(deliveries.map((job) => job.remove()));
  });

  test("replaces a retained failed delivery for a still-queued durable job", async () => {
    const failedDeliveryId = `${durableJobId}-failed`;
    const redisUrl = process.env.REDIS_URL ?? "redis://unused";
    const workerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    const failedWorker = new Worker<QueuePayload>(
      queueName(environment),
      async () => { throw new Error("delivery failed"); },
      { connection: workerConnection, prefix: "swarmloom", concurrency: 1 },
    );
    let failedWorkerClosed = false;
    try {
      await inspector.add("execute", queuePayload(durableJobId, environment), {
        jobId: failedDeliveryId,
        attempts: 1,
        removeOnFail: false,
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await inspector.getJob(failedDeliveryId).then((job) => job?.getState()).then((state) => state === "failed")) break;
        await Bun.sleep(20);
      }
      expect(await inspector.getJob(failedDeliveryId).then((job) => job?.getState())).toBe("failed");
      await failedWorker.close();
      failedWorkerClosed = true;

      await jobQueue.enqueue(durableJobId);

      expect(await inspector.getJob(failedDeliveryId)).toBeUndefined();
      const replacements = (await inspector.getJobs(["waiting"])).filter((job) => job.data.jobId === durableJobId);
      expect(replacements).toHaveLength(1);
      expect(replacements[0]?.id).not.toBe(failedDeliveryId);
      await replacements[0]?.remove();
    } finally {
      if (!failedWorkerClosed) await failedWorker.close();
      workerConnection.disconnect();
    }
  });
});

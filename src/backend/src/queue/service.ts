import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import type { Config } from "../core/config-schema.ts";

export type QueuePayload = { jobId: string; environment: string };
export type QueueProcessor = (payload: QueuePayload) => Promise<void>;

export function queueName(environment: string) {
  return `swarmloom-${environment}-jobs`;
}

export function queuePayload(jobId: string, environment: string): QueuePayload {
  return { jobId, environment };
}

export function createJobQueue(config: Pick<Config, "APP_ENV" | "REDIS_URL">) {
  const name = queueName(config.APP_ENV);
  const prefix = "swarmloom";
  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<QueuePayload>(name, { connection, prefix });
  const workers: Array<Worker<QueuePayload>> = [];
  const workerConnections: IORedis[] = [];

  async function enqueue(jobId: string, deliveryId = jobId) {
    try {
      await queue.add("execute", queuePayload(jobId, config.APP_ENV), {
        jobId: deliveryId,
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
        removeOnFail: { age: 30 * 24 * 60 * 60, count: 5_000 },
      });
    } catch (error) {
      if (await queue.getJob(deliveryId)) return;
      throw error;
    }
  }

  async function remove(jobId: string) {
    const job = await queue.getJob(jobId);
    if (!job) return false;
    try {
      await job.remove();
      return true;
    } catch {
      return false;
    }
  }

  function createWorker(processor: QueueProcessor, concurrency: number) {
    const workerConnection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
    const worker = new Worker<QueuePayload>(name, (job) => processor(job.data), {
      connection: workerConnection,
      prefix,
      concurrency,
      autorun: true,
    });
    workerConnections.push(workerConnection);
    workers.push(worker);
    return worker;
  }

  return {
    enqueue,
    remove,
    createWorker,
    health: () => connection.ping(),
    close: async () => {
      await Promise.all(workers.map((worker) => worker.close()));
      await queue.close();
      connection.disconnect();
      for (const workerConnection of workerConnections) workerConnection.disconnect();
    },
  };
}

export type JobQueue = ReturnType<typeof createJobQueue>;
export type QueueWorker = ReturnType<JobQueue["createWorker"]>;
export type BullJob = Job<QueuePayload>;

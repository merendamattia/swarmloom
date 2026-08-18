import { describe, expect, test } from "bun:test";
import { queueName, queuePayload } from "../src/queue/service.ts";

describe("job queue contract", () => {
  test("namespaces the queue by environment and carries no job payload secrets", () => {
    expect(queueName("test")).toBe("swarmloom-test-jobs");
    expect(queuePayload("job-123", "test")).toEqual({ jobId: "job-123", environment: "test" });
  });
});

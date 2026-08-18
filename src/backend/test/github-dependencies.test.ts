import { describe, expect, test } from "bun:test";
import { dependencyStatus } from "../src/github/dependencies.ts";

describe("issue dependency status", () => {
  test("an open parent keeps the child out of the runnable set", () => {
    expect(dependencyStatus(parent({ state: "open", stateReason: null }))).toEqual({
      satisfied: false,
      reason: "Waiting for prerequisite issue #5 to be implemented",
    });
  });

  test("a reopened parent blocks the child again", () => {
    expect(dependencyStatus(parent({ state: "open", stateReason: "reopened" }))).toEqual({
      satisfied: false,
      reason: "Waiting for prerequisite issue #5 to be implemented",
    });
  });

  test("a closed parent releases the child", () => {
    expect(dependencyStatus(parent({ state: "closed", stateReason: "completed" }))).toEqual({
      satisfied: true,
      reason: null,
    });
  });

  test("a parent closed without a reason still releases the child", () => {
    expect(dependencyStatus(parent({ state: "closed", stateReason: null }))).toEqual({
      satisfied: true,
      reason: null,
    });
  });

  test("a parent closed as not planned leaves the child permanently deferred", () => {
    expect(dependencyStatus(parent({ state: "closed", stateReason: "not_planned" }))).toEqual({
      satisfied: false,
      reason: "Prerequisite issue #5 was closed as not planned",
    });
  });

  test("a duplicate parent leaves the child permanently deferred", () => {
    expect(dependencyStatus(parent({ state: "closed", stateReason: "duplicate" }))).toEqual({
      satisfied: false,
      reason: "Prerequisite issue #5 was closed as duplicate",
    });
  });

  function parent(overrides: Partial<{ state: string; stateReason: string | null }>) {
    return {
      number: 5,
      title: "Foundation first",
      url: "https://github.com/acme/app/issues/5",
      state: "open",
      stateReason: null as string | null,
      ...overrides,
    };
  }
});

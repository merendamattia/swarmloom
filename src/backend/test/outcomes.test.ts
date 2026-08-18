import { describe, expect, test } from "bun:test";
import { parseJobOutcome, parseReviewOutcome } from "../src/runner/outcomes.ts";

describe("agent outcomes", () => {
test("accepts the four explicit job outcomes", () => {
    expect(parseJobOutcome('{"outcome":"requires_decomposition","summary":"Too broad","reason":"Two releases"}').outcome)
      .toBe("requires_decomposition");
    expect(parseJobOutcome('{"outcome":"blocked","summary":"Missing API","question":"Which API?"}').outcome)
      .toBe("blocked");
    expect(parseJobOutcome('{"outcome":"decomposed","summary":"Split","childIssues":[{"number":2,"url":"https://github.com/a/b/issues/2","ready":true},{"number":3,"url":"https://github.com/a/b/issues/3","ready":false}]}').outcome)
      .toBe("decomposed");
    expect(parseJobOutcome('{"outcome":"implemented","summary":"Done","tests":["bun test"],"commit":"abcdef1","pr":{"number":4,"url":"https://github.com/a/b/pull/4","base":"develop","head":"agent/issue-1"}}').outcome)
      .toBe("implemented");
  });

  test("rejects prose and a PR with the wrong base", () => {
    expect(() => parseJobOutcome("Done")).toThrow("valid JSON");
    expect(() => parseJobOutcome('{"outcome":"implemented","summary":"Done","tests":[],"commit":"abcdef1","pr":{"number":4,"url":"https://github.com/a/b/pull/4","base":"main","head":"x"}}'))
      .toThrow("invalid job outcome");
  });

  test("extracts the single JSON document from fenced or surrounding text", () => {
    const input = '{"outcome":"blocked","summary":"Missing API","question":"Which API?"}';
    expect(parseJobOutcome(`\`\`\`json\n${input}\n\`\`\``).outcome).toBe("blocked");
    expect(parseJobOutcome(`Here is the result:\n${input}\nLet me know if you need more.`).outcome)
      .toBe("blocked");
    expect(parseJobOutcome(`\n\n${input}`).outcome).toBe("blocked");
  });

  test("still rejects prose that contains no JSON document", () => {
    expect(() => parseJobOutcome("Done and done")).toThrow("valid JSON");
    expect(() => parseJobOutcome("{} followed by prose")).toThrow("invalid job outcome");
  });

  test("allows non-blocking findings on passing reviews but requires findings for changes", () => {
    expect(parseReviewOutcome('{"verdict":"pass","summary":"Looks good","findings":[{"file":"README.md","line":1,"severity":"low","problem":"Cosmetic issue","correction":"Tidy it up"}]}').verdict)
      .toBe("pass");
    expect(() => parseReviewOutcome('{"verdict":"changes_requested","summary":"Broken","findings":[]}'))
      .toThrow("invalid review outcome");
  });

  test("accepts Codex structured output null placeholders", () => {
    const result = parseJobOutcome(JSON.stringify({
      outcome: "blocked",
      summary: "Missing API",
      tests: null,
      commit: null,
      pr: null,
      reason: null,
      childIssues: null,
      question: "Which API?",
    }));
    expect(result.outcome).toBe("blocked");
  });

  test("uses the last structured output after Codex progress messages", () => {
    const progress = JSON.stringify({
      outcome: "implemented",
      summary: "Working",
      tests: null,
      commit: null,
      pr: null,
      reason: null,
      childIssues: null,
      question: null,
    });
    const final = JSON.stringify({
      outcome: "implemented",
      summary: "Done",
      tests: [],
      commit: "abcdef1",
      pr: { number: 4, url: "https://github.com/a/b/pull/4", base: "develop", head: "agent/issue-1" },
      reason: null,
      childIssues: null,
      question: null,
    });
    expect(parseJobOutcome(`${progress}\n${final}`).summary).toBe("Done");
  });
});

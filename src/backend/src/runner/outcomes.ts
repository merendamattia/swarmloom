import { z } from "zod";

const implemented = z.object({
  outcome: z.literal("implemented"),
  summary: z.string().min(1),
  tests: z.array(z.string()),
  commit: z.string().min(7),
  pr: z.object({
    number: z.number().int().positive(),
    url: z.url(),
    base: z.literal("develop"),
    head: z.string().min(1),
  }).strict(),
}).strict();

const blocked = z.object({
  outcome: z.literal("blocked"),
  summary: z.string().min(1),
  question: z.string().min(1),
}).strict();

const requiresDecomposition = z.object({
  outcome: z.literal("requires_decomposition"),
  summary: z.string().min(1),
  reason: z.string().min(1),
}).strict();

const decomposed = z.object({
  outcome: z.literal("decomposed"),
  summary: z.string().min(1),
  childIssues: z.array(z.object({
    number: z.number().int().positive(),
    url: z.url(),
    ready: z.boolean(),
  }).strict()).min(2),
}).strict();

const jobOutcomeSchema = z.discriminatedUnion("outcome", [
  implemented,
  blocked,
  requiresDecomposition,
  decomposed,
]);

const reviewOutcomeSchema = z.object({
  verdict: z.enum(["pass", "changes_requested"]),
  summary: z.string().min(1),
  findings: z.array(z.object({
    file: z.string().min(1),
    line: z.number().int().positive().nullable(),
    severity: z.enum(["low", "medium", "high", "critical"]),
    problem: z.string().min(1),
    correction: z.string().min(1),
  }).strict()),
}).strict().superRefine((outcome, context) => {
  if (outcome.verdict === "changes_requested" && outcome.findings.length === 0) {
    context.addIssue({ code: "custom", path: ["findings"], message: "Findings are required" });
  }
});

function json(text: string) {
  const candidate = text.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const embedded = extractJsonDocument(candidate);
    if (embedded !== undefined) {
      try {
        return JSON.parse(embedded);
      } catch {
        // fall through to the dedicated error below
      }
    }
    throw new Error("Agent result is not valid JSON");
  }
}

function extractJsonDocument(text: string): string | undefined {
  let last: string | undefined;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const document = extractJsonAt(text, start);
    if (document) {
      last = document;
      start += document.length - 1;
    }
  }
  return last;
}

function extractJsonAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          JSON.parse(slice);
          return slice;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function parseJobOutcome(text: string) {
  const parsed = jobOutcomeSchema.safeParse(stripNullPlaceholders(json(text)));
  if (!parsed.success) throw new Error("Agent returned an invalid job outcome");
  return parsed.data;
}

export function parseReviewOutcome(text: string) {
  const parsed = reviewOutcomeSchema.safeParse(json(text));
  if (!parsed.success) throw new Error("Agent returned an invalid review outcome");
  return parsed.data;
}

export function requiresFollowUp(review: ReviewOutcome) {
  return review.verdict === "changes_requested" || review.findings.length > 0;
}

function stripNullPlaceholders(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}

export type JobOutcome = z.infer<typeof jobOutcomeSchema>;
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

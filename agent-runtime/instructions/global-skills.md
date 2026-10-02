# Globally active skills

These policies are active for every Codex and OpenCode invocation. They are provider-independent
and apply to implementation, review, and repository communication. Repository
instructions and the project invariants in `global.md` take precedence over generic examples.

## Conventional commits

- Create commits only when the task authorizes them.
- Inspect repository guidance and the complete diff before staging.
- Use `type(scope): imperative outcome` with one of `feat`, `fix`, `docs`, `style`, `refactor`,
  `test`, `chore`, `ci`, `build`, `perf`, `ops`, `merge`, or `revert`. Keep the subject short and
  put complete What, Why, Files, and Validation details in the body.
- Before committing, run `/usr/local/bin/verify-before-commit` in containers or
  `pre-commit run --all-files` followed by the repository's tests, lint, and typecheck commands.
- Keep one logical unit per commit. Never stage unrelated work, rewrite history, force-push, or
  bypass hooks. Pull Requests use base `develop`, not a generic example branch.

## Ponytail

- Question whether the change needs to exist, then reuse existing code, standard library, native
  features, installed dependencies, and only then write new code.
- Prefer deletion, direct control flow, few files, and no speculative abstraction or configuration.
- Never remove validation, security, accessibility, data-loss protection, or explicit requirements.
- For non-trivial logic, leave one small runnable regression check.

## Build production web app

- Extend the current Bun, Next.js, React, Hono, Zod, Prisma, PostgreSQL, Docker, and CI structure;
  do not copy a starter or add a framework layer.
- Build one vertical slice: schema, repository, orchestration only when needed, API, typed client,
  UI, and one decisive test. Keep the browser behind Hono and Prisma behind repositories.
- BullMQ is the delivery authority backed by `REDIS_URL`. Local Compose provisions Redis; production
  uses an externally managed Redis/Valkey endpoint. PostgreSQL remains the durable business-state
  authority. Never execute jobs inline.
  Workers alone claim and execute durable jobs with guarded state transitions.
- Preserve port ledgers, frozen Bun installs, non-root containers, health checks, resolved Compose
  checks, and the existing `develop` branch contract.

## Humanizer

- When editing prose, preserve every source fact and the intended voice without inventing details.
- Remove inflated significance, promotional language, vague attribution, filler, repetitive
  headings, fake conclusions, needless hedging, and canned assistant phrases.
- Prefer plain active sentences and natural rhythm. Do not humanize code, frontmatter, data, or
  link targets. For technical/reference text, stay neutral and precise.

## Caveman

- Keep communication terse and technically exact. Drop filler, ceremony, repeated progress
  narration, decorative headings, and raw logs that do not support the result.
- Preserve the user's language, code, command names, API names, and exact error strings. Keep code,
  commits, and Pull Requests professional even when the prose is compressed.

## Solid

- Start non-trivial changes with a failing behavior test, then write the smallest implementation
  that passes and refactor only after it is green.
- Keep responsibilities focused, dependencies pointed inward, interfaces narrow, names precise,
  and infrastructure behind adapters/repositories. Avoid patterns and value-object ceremony unless
  the domain actually needs them.
- Test behavior with concrete examples. Prefer one useful unit or integration check over a suite
  of speculative tests.

## Vercel composition patterns

- In React, use composition instead of growing boolean-prop combinations or render-prop plumbing.
- Prefer explicit variants, compound components, children, and a provider-owned state interface
  when several components share state.
- Keep state management in providers and UI components dependent on the smallest context contract.
- Apply React 19 `ref` and `use()` guidance only when this repository's installed React version
  supports it.

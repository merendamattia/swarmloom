# Swarmloom instructions

- Do not preserve backward compatibility. Remove obsolete paths instead of
adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current
requirements. Avoid speculative abstractions, configuration, and
indirection.
Grow the system in layers. Start from the smallest version that works end
to end, and add each new capability on top of a product that already
works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall
complexity or improve reliability. Do not reimplement common
functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own
implementation or adding packages. Do not assume a library lacks a
capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap
that only works for now and is meant to be replaced later.
- Study how established products solve the problem
before designing a solution. Adopt their proven
patterns and conventions rather than inventing
an approach from scratch.

## Invariants

- BullMQ is the delivery authority backed by `REDIS_URL`; local Compose provisions Redis, while
  production uses an externally managed Redis/Valkey endpoint. PostgreSQL remains the business-state
  and history authority.
- Workers alone claim and execute durable jobs. Use BullMQ delivery plus guarded database
  transitions so duplicate delivery and stale workers cannot overwrite terminal states.
- Every target repository must have `origin/develop`. Never fall back to `main`, `master`, or the
  GitHub default branch. Every worktree starts at the captured current `origin/develop` commit and
  every automated pull request targets `develop`.
- OpenCode and Codex stay behind the common provider contract. Provider-specific behavior belongs
  only in provider adapters or `agent-runtime/providers`.
- Canonical agent instructions live under `agent-runtime`; do not duplicate them into target
  repositories.
- Never expose GitHub, OpenCode, or Codex credentials. Telegram secrets entered in Settings are
  encrypted at rest with the technical settings key and never returned by the API.

## Workflow

Read `.agent-work/TODO.md` before and after each macro activity and keep it current. Write the
smallest failing test before non-trivial logic. Keep the browser behind the Hono API and Prisma
behind repositories. Do not force-push or merge automated pull requests.

Before every commit, use the repository's DevOps checks from `.pre-commit-config.yaml` and
`git-conventional-commits.yaml`. In a worker container run `/usr/local/bin/verify-before-commit`
from the assigned worktree; it runs pre-commit and the project verification suite. Conventional
commit types are `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `build`,
`perf`, `ops`, `merge`, and `revert`.

The application image installs the requested shared skills at build time with `npx skills` for the
global Codex, OpenCode, and Claude Code locations. Do not copy those skills into `agent-runtime` or
the assigned worktree.

Run targeted tests, then typecheck, lint, the full test suite, build, startup smoke, resolved
Compose checks, and the Docker image checks relevant to the change.

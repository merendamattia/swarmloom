# Swarmloom — deployment and operations

This is the operator guide for the implementation in this repository. Commands use Docker Compose
v2 and the production file `docker-compose.production.yaml`. Run them from the repository root.

## What the application does

Swarmloom scans configured repositories with two logically independent scanners behind one
scheduler. For every acquired issue or managed Pull Request it:

1. fetches the current `origin/develop`;
2. stores the issue snapshot and exact baseline commit in PostgreSQL;
3. **IssueScanner** — for issues carrying `agent:ready`:
   removes the ready label, adds the working label, and queues an `IMPLEMENTATION` job;
4. **PullRequestScanner** — runs before IssueScanner for every repository tick. It imports open Pull
   Requests carrying one of the Swarmloom PR workflow labels (using the same label-filtered GitHub
   issue listing as issue discovery), associates `agent/issue-<number>-…` branches with their
   originating issue, and then reconciles each managed PR from its labels and current head SHA:
   - `agent:review-requested` → one `REVIEW` job for that exact head SHA;
   - `agent:fix-requested` → a `FIX` job on the same PR branch;
   - `agent:review-passed` → wait for the human merge; once merged, the originating issue becomes
     `agent:done`;
   - a persisted implementation PR missing its workflow label → restore
     `agent:review-requested` and queue its review;
5. **Implementation jobs** create a dedicated branch and persistent Git worktree from the captured
   `origin/develop` commit, run a fresh Codex or OpenCode session with the canonical material in
   `agent-runtime` (including the current issue, comments, and linked PR context), verify that the
   resulting PR points from the assigned branch to `develop` and links the issue, persist the PR
   association in PostgreSQL, and apply `agent:review-requested` to the Pull Request. They never run
   the reviewer and never wait for CI.
6. **FIX jobs** work on the already-open PR branch, receive the reviewer feedback, push to the same
   remote branch, and validate that the PR head actually moved.
7. **REVIEW jobs** are independent durable jobs targeting one PR and one head SHA. They load the PR
   metadata, diff, comments, review history, originating issue, and available GitHub Actions context,
   reproduce the repository CI locally, run a fresh reviewer session, post the result to the PR, and
   persist it in PostgreSQL. `Review: pass` applies
   `agent:review-passed` to the PR and `agent:ready-to-merge` to the issue; `Review:
   changes_requested` applies `agent:fix-requested` with the reviewer feedback. A result computed for
   an outdated head SHA is recognized as stale and can never finalize a newer head.
8. A configurable safety limit (default five consecutive fix cycles per PR) stops the automatic
   fix/review loop, blocks the workflow, and applies `agent:human-review` with an explanatory
   comment;
9. on a failed job, records and comments the redacted error. A separate `agent:ready` diagnostic
   issue is created only when the opt-in Settings toggle is enabled;
10. stores lifecycle data and events in PostgreSQL, reconciles GitHub labels/comments, and sends
    selected Telegram notifications.

The API/scheduler, BullMQ worker, and dashboard are process roles of one TypeScript application.
BullMQ owns delivery through the externally managed Redis/Valkey endpoint supplied by `REDIS_URL`;
PostgreSQL owns business state, history, events, and runtime settings. There is no webhook dependency
or automatic PR merge. Both Compose files pin the Docker project name to `swarmloom`, so newly
created containers, networks, and named volumes no longer inherit the checkout directory's legacy
name.

## Security boundary

The production Compose file binds the dashboard and API to `127.0.0.1`. The application has no
built-in user accounts. Keep those ports private and use one of these boundaries:

- an SSH tunnel for a single operator; or
- a trusted reverse proxy/VPN that adds TLS and authentication.

Do not publish ports `18420` or `18421` directly to the Internet. A GitHub issue can cause an agent
to execute repository code and push a branch, so only trusted people should be able to add the
queue label. Use a dedicated fine-grained GitHub token, a disposable test repository for initial
verification, and a VPS/container that does not hold unrelated secrets.

GitHub tokens remain environment-only and provider sessions are read only from their auth volumes.
Telegram secrets may be entered in Settings, are encrypted with `SETTINGS_ENCRYPTION_KEY` before
PostgreSQL persistence, and are never returned by the API. Provider output and errors are redacted
against known credential values before persistence.

## Architecture and persistent state

| Component | Responsibility | Durable storage |
|---|---|---|
| `backend` | Hono API, cron scheduler, issue/PR discovery and reconciliation, migrations, queue producer | PostgreSQL and repository volume |
| `worker` | BullMQ consumer, guarded claims, heartbeats, worktrees, provider sessions for implementation, fix, review, and decomposition jobs | PostgreSQL and repository volume |
| `frontend` | Operational Next.js dashboard | None |
| External PostgreSQL | Jobs, managed Pull Requests, reviews, scans, events, repository state, heartbeats, runtime settings | Provider-managed |
| External Redis/Valkey | BullMQ delivery, retries, locks, worker coordination | Provider-managed |
| Codex CLI | Selected agent runtime | `codex_home` for account login cache |
| OpenCode CLI | Selected agent runtime | `opencode_data` and `opencode_config` |
| Shared agent skills | Build-time skills for Codex, OpenCode, and Claude Code | Image global skill directories |
| `agent-runtime` | Canonical global instructions and skills | Production image; local read-only bind mount |

The `worker_data` volume contains persistent clones under `/data/repositories` and worktrees under
`/data/worktrees`. Worktrees are removed once their job reaches a terminal state; local clones are
garbage-collected after each run and pruned when they are no longer needed.

## Repository requirements

Every configured repository must meet all of these conditions:

- a remote branch named exactly `develop` exists;
- the GitHub token can read issues and clone/fetch, and can write labels, comments, branches, and
  Pull Requests;
- the token can create and update the configured queue/status labels during startup;
- repository tests and build tooling can run inside the Debian-based worker image; integration
  tests that need Postgres or Redis use the ephemeral local servers bundled in the image via
  `swarm-test-services` (no Docker inside the worker);
- repository-local `AGENTS.md` and conventions do not contradict the worker's safety and
  mandatory-branch constraints.

There is no fallback to `main`, `master`, or the GitHub default branch. Before each job is inserted,
the scanner fetches `refs/heads/develop` into `refs/remotes/origin/develop` and resolves the commit.
The job branch and worktree start at that captured commit. Every generated PR must target
`develop`; the deterministic runner rejects a PR with another base, another head branch, or no link
to the original issue.

Check a target repository before adding it:

```bash
GH_TOKEN=your-token gh api repos/OWNER/REPO/git/ref/heads/develop --jq .object.sha
GH_TOKEN=your-token git ls-remote --exit-code https://github.com/OWNER/REPO.git refs/heads/develop
```

## GitHub token and labels

Create a fine-grained personal access token scoped only to the monitored repositories. The worker's
general workflow needs repository permissions:

- **Contents: read and write** — clone/fetch and push the assigned branch;
- **Issues: read and write** — discovery, labels, comments, issue creation, and native sub-issues;
- **Pull requests: read and write** — create/read PRs and post review-related content;
- **Actions: read** — lets reviewers inspect workflow runs and failed jobs; review still proceeds
  with local CI reproduction if remote Actions data is unavailable;
- **Metadata: read** — automatically included by GitHub;
- **Workflows: write** only if queued work is allowed to modify files in `.github/workflows`.

GitHub documents endpoint-to-permission mappings in its [fine-grained token permission
reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).
The native add-sub-issue endpoint specifically requires Issues write permission and accepts a
numeric child issue ID; see the [sub-issues REST API](https://docs.github.com/en/rest/issues/sub-issues).

On every API/worker startup, the application checks each configured repository and creates the
configured worker labels when they are missing. Existing worker labels are updated with the
canonical color and description. No manual label setup is required; the token needs Issues write
permission.

Label flow:

- **Issues** carry the workflow state of the originating issue:
  `ready` → `working` when discovery atomically acquires the issue; `working` →
  `ready-to-merge` when an automated review passes; `ready-to-merge` → `done` after a human merge;
  `working` → `blocked` when essential information is missing; `working` → `decomposed` after child
  issues are created;
- **Pull Requests** carry their own workflow state: `review-requested` after implementation and
  after every fix; `fix-requested` after requested review changes; `review-passed`
  after a passing review, while the merge remains human;
- the reviewer inspects GitHub Actions when available and always reproduces CI locally; failed CI is
  reported as reviewer feedback, which moves the PR to `fix-requested`;
- when the automatic fix cycle limit is exceeded, the PR and issue receive `agent:human-review`
  and automation stops until a human intervenes;
- failed jobs always remain visible in job/event history and move the originating issue to
  `agent:blocked`; creating a separate `agent:ready` diagnostic issue is optional and disabled by
  default;
- stale issue jobs also move the issue to `agent:blocked`; stale PR jobs restore their review/fix
  trigger for the next scan;
- cancellation removes worker labels while unrelated labels are always preserved;
- Retry restores the relevant label (`ready` on issues, the requested label on Pull Requests), then
  a new scan captures fresh state and creates a new history row. The earlier row is never
  overwritten.

Only these labels create work during a scan:

| Trigger label | Subject | Job created |
|---|---|---|
| `agent:ready` | Issue | `IMPLEMENTATION` from the captured `origin/develop` SHA |
| `agent:review-requested` | Managed Pull Request | `REVIEW` for the current PR head SHA |
| `agent:fix-requested` | Managed Pull Request | `FIX` on the existing PR branch and current head SHA |

`DECOMPOSITION` has no trigger label: an `IMPLEMENTATION` result of
`Outcome: requires_decomposition` creates it directly as a separate durable job. The labels
`agent:working`, `agent:blocked`, `agent:decomposed`, `agent:ready-to-merge`, `agent:done`,
`agent:review-passed`, and `agent:human-review` are waiting, terminal, or intervention states and do
not create jobs. Worker transitions replace only worker-owned labels and preserve unrelated labels.

## Environment variables

Start from `.env.production.example`. Values marked "required" are enforced by Compose or startup
validation.

| Variable | Required/default | Meaning |
|---|---|---|
| `APP_ENV` | `production` in production Compose | Isolates job/scan claims by deployment environment |
| `NODE_ENV` | `production` in production Compose | Runtime mode |
| `DATABASE_URL` | required | Only PostgreSQL connection string used by the application |
| `REDIS_URL` | required in production; `redis://redis:6379` locally | External Redis/Valkey connection used by BullMQ |
| `SETTINGS_ENCRYPTION_KEY` | required; 32+ characters | Technical key used to encrypt Telegram settings at rest |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | local Compose only | Local PostgreSQL bootstrap values; production PostgreSQL is external |
| `GITHUB_TOKEN` | required | Fine-grained token; also exposed to agent sessions as `GH_TOKEN` |
| `GITHUB_REPOSITORIES` | required | Comma/whitespace-separated `owner/repository` values |
| `GITHUB_API_URL` | `https://api.github.com` | REST API base, useful for GitHub Enterprise |
| `GIT_AUTHOR_NAME` | `swarmloom` | Commit author/committer name for agent sessions |
| `GIT_AUTHOR_EMAIL` | noreply default | Commit author/committer email |
| `ISSUE_READY_LABEL` | `agent:ready` | Issue queue label |
| `ISSUE_WORKING_LABEL` | `agent:working` | Acquired/running issue label |
| `ISSUE_BLOCKED_LABEL` | `agent:blocked` | Missing-information label |
| `ISSUE_COMPLETED_LABEL` | `agent:done` | Issue finalized after a human merge |
| `ISSUE_DECOMPOSED_LABEL` | `agent:decomposed` | Parent decomposed label |
| `ISSUE_READY_TO_MERGE_LABEL` | `agent:ready-to-merge` | Automation passed; human merge still required |
| `ISSUE_HUMAN_REVIEW_LABEL` | `agent:human-review` | Human intervention required label |
| `PR_REVIEW_REQUESTED_LABEL` | `agent:review-requested` | PR requires automated review |
| `PR_FIX_REQUESTED_LABEL` | `agent:fix-requested` | PR requires a fix after requested review changes |
| `PR_REVIEW_PASSED_LABEL` | `agent:review-passed` | Review passed; PR awaits a human merge |
| `MAX_AUTOMATIC_FIX_CYCLES` | `5` | Consecutive fix cycles per PR before the workflow is blocked for human review |
| `CREATE_DIAGNOSTIC_ISSUES` | `false` | Opens a separate ready-labelled diagnostic issue when a job fails; editable from Settings |
| `SCHEDULE_CRON` | `*/30 * * * *` | Five-part cron expression; reconciles PRs and discovers issues every 30 minutes by default |
| `SCHEDULE_TIMEZONE` | `UTC` | IANA timezone used by Croner |
| `MAX_PARALLEL_JOBS` | `1` | BullMQ worker concurrency; editable from Settings |
| `WORKER_ID` | environment-specific default | Stable worker heartbeat identity |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Job and service heartbeat interval |
| `STALE_JOB_THRESHOLD_MS` | `60000` | Running job older than this becomes `STALE` at worker startup |
| `AGENT_TIMEOUT_MS` | `7200000` | Maximum provider session duration before abort |
| `DATA_DIR` | `/data` in Compose | Clone/worktree root |
| `AGENT_RUNTIME_DIR` | `/app/agent-runtime` | Canonical runtime path inside the container |
| `AGENT_RUNTIME_HOST_PATH` | `./agent-runtime`, local Compose only | Host directory mounted read-only at `AGENT_RUNTIME_DIR` during development |
| `AGENT_PROVIDER` | required; `codex` example | Exactly `codex` or `opencode` |
| `CODEX_MODEL` | `gpt-5.6-luna` | Codex model stored on each queued job |
| `CODEX_REASONING_EFFORT` | `max` | Codex reasoning setting; supports validated CLI values |
| `OPENCODE_MODEL` | `opencode-go/deepseek-v4-flash` | OpenCode `provider/model` stored on each queued job |
| `CODEX_HOME` | `/data/codex-home` | Persistent Codex auth/config directory |
| `XDG_DATA_HOME` | `/data/opencode-data` | Persistent OpenCode data/auth root |
| `XDG_CONFIG_HOME` | `/data/opencode-config` | Persistent XDG config root |
| `OPENCODE_CONFIG_DIR` | `/data/opencode-config` | Explicit OpenCode config directory |
| `OPENCODE_PERMISSION` | `{"*":"allow"}` in Compose | Noninteractive tool permission policy inside the worker container |
| `TELEGRAM_ENABLED` | `false` | Completely enables/disables Telegram delivery |
| `TELEGRAM_BOT_TOKEN` | optional bootstrap value | Bot token; Settings encrypts and stores it in PostgreSQL |
| `TELEGRAM_CHAT_ID` | optional bootstrap value | Private/group/channel destination ID; Settings stores it encrypted |
| `FRONTEND_URL` | required in production | Exact browser origin allowed by API CORS |
| `PUBLIC_API_URL` | required at image build | API origin embedded into the browser bundle |
| `FRONTEND_PORT` | `18420` | Loopback dashboard host port |
| `BACKEND_PORT` | `18421` | Loopback API host port |
| `REDIS_PORT` | `18422` locally | Loopback Redis host port; production uses the external `REDIS_URL` |
| `POSTGRES_PORT` | `17432` locally | Local-only host port; production PostgreSQL is not published |
| `CODEX_CLI_VERSION` | `0.147.0` | Docker build pin |
| `OPENCODE_CLI_VERSION` | `1.18.18` | Docker build pin; must support the configured `opencode-go` provider |

`PORT` is an internal backend variable set to `18421` by Compose. `GH_TOKEN` and Git committer
variables are derived inside the deployment and do not need separate user configuration.

## First deployment

The sequence below goes from a cloned repository to the first completed test job.

1. Install Docker Engine with the Compose v2 plugin on the VPS. Clone this repository and enter it.

2. Create the production environment and edit every placeholder:

   ```bash
   cp .env.production.example .env.production
   chmod 600 .env.production
   editor .env.production
   ```

   Use a long random `POSTGRES_PASSWORD`, put the identical value into `DATABASE_URL`, select the
   disposable test repository in `GITHUB_REPOSITORIES`, and choose the first provider.

3. Decide access mode before building:

   - SSH tunnel only: set `FRONTEND_URL=http://localhost:18420` and
     `PUBLIC_API_URL=http://localhost:18421`.
   - Authenticated reverse proxy on one host: set both to `https://worker.example.com`, route
     `/api/*` to `127.0.0.1:18421`, and all other paths to `127.0.0.1:18420`.

4. Resolve configuration and build the shared image. The image build itself runs both provider
   version commands.

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yaml config --quiet
   docker compose --env-file .env.production -f docker-compose.production.yaml build backend
   ```

5. Start PostgreSQL, run migrations through the backend command, and start all roles:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yaml up -d
   docker compose --env-file .env.production -f docker-compose.production.yaml ps
   ```

6. Log in interactively to the selected provider from the online worker.

   For Codex account/device auth, run:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yaml exec worker codex login --device-auth
   ```

   For OpenCode + DeepSeek, run:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yaml exec worker opencode auth login
   ```

7. Verify readiness and the selected runtime:

   ```bash
   curl --fail http://127.0.0.1:18421/api/health
   curl --fail http://127.0.0.1:18421/api/status
   docker compose --env-file .env.production -f docker-compose.production.yaml exec worker codex --version
   docker compose --env-file .env.production -f docker-compose.production.yaml exec worker opencode --version
   ```

8. Create `develop` in the disposable repository. Startup creates the configured labels. Create a
   small, independently verifiable issue and apply `agent:ready`:

   ```bash
   GH_TOKEN=your-token gh issue create --repo OWNER/REPO \
     --title "Worker E2E: add a tested documentation note" \
     --body "Objective: add docs/worker-e2e.md. Acceptance: file explains this test; run the repository's documentation checks." \
     --label agent:ready
   ```

9. Trigger discovery from the dashboard's **Run now** action or directly:

   ```bash
   curl --fail -X POST http://127.0.0.1:18421/api/scans/run
   ```

10. Follow `backend` and `worker` logs and open the dashboard. The expected terminal evidence is a
    new job row, a pushed PR targeting `develop`, a separate review row, an issue comment/status
    label, and the full event timeline in PostgreSQL/dashboard. The worker never merges the PR.

## Dashboard and API operations

For an SSH-only deployment, open tunnels from your workstation:

```bash
ssh -L 18420:127.0.0.1:18420 -L 18421:127.0.0.1:18421 user@vps
```

Then open `http://localhost:18420`. Operational endpoints are under `http://localhost:18421/api`:

The dashboard has four operator surfaces: **Overview** for the health verdict, exceptions, active
work, recent scans, and Run now/Telegram test actions; **Jobs** for server-filtered, paginated
history; **Job detail** for lifecycle facts, long output, review evidence, cancel, and retry; and
**Repositories** for `develop` validity, synchronized baselines, and recent attempts. Loading,
empty, API-unavailable, invalid-repository, stale/failed, and narrow-screen states are explicit.

- `GET /health` — database, scheduler, provider, and worker heartbeat status;
- `GET /status` — safe configuration, selected provider/model, Telegram state;
- `GET /dashboard` — counts, repositories, scans, recent jobs, heartbeats;
- `GET /jobs` and `GET /jobs/:id` — filtered history and timeline;
- `GET /repositories`, `GET /scans`, `GET /events` — operational history;
- `GET/PATCH /settings` — runtime configuration without exposing Telegram secrets;
- `POST /scans/run` — the same scanner used by cron;
- `POST /jobs/:id/cancel` — cancels queued/running work and causes a running provider to abort on
  the next heartbeat;
- `POST /jobs/:id/retry` — eligible only for failed, blocked, cancelled, or stale jobs;
- `POST /notifications/test` — persists and dispatches a Telegram test event.

The dashboard polls only while active work is present. PostgreSQL rows remain authoritative if a
browser closes or a container restarts.

## Scheduler, locking, and parallelism

`SCHEDULE_CRON` is a five-part expression evaluated in `SCHEDULE_TIMEZONE`. The default
`*/30 * * * *` runs both scanners every 30 minutes. Invalid expressions fail validation. Both
values can be changed from Settings; the API restarts the scheduler after a successful update.

One scheduler tick runs `IssueScanner` (ready issues → `IMPLEMENTATION` jobs) and
`PullRequestScanner` (managed open PRs → `FIX`/`REVIEW` jobs and merge finalization) with separate
responsibilities and the same durable scan lifecycle. Scheduled and manual runs call the same
pipeline. A nullable unique `activeEnvironmentKey` in PostgreSQL permits one active scan per
`APP_ENV`; a competing request is recorded as `SKIPPED`. Issues have a unique active key
(repository + issue) and Pull Request jobs have a unique active key
(repository + PR + head SHA + job kind), so duplicate scans cannot create duplicate active work.
The scanners write the durable PostgreSQL history rows, then enqueue the same `queueJobId` in
BullMQ. Workers alone perform a guarded `QUEUED` → `RUNNING` transition, so duplicate delivery is
ignored. Set `MAX_PARALLEL_JOBS=1` for sequential behavior; raising it changes BullMQ worker
concurrency. BullMQ owns retries and locks while PostgreSQL retains the visible business state.

At worker startup, expired running jobs become `STALE` and release their active key. For issue jobs
the issue returns to the unlabelled state; for PR jobs the scanner-facing label is restored so the
next scan reschedules the work. Use Retry to create a new attempt/history row.

## Agent runtime

`agent-runtime` is the provider-independent source of truth:

```text
agent-runtime/
├── instructions/{global-skills,global}.md
└── providers/{codex,opencode}/README.md
```

The runner loads the same global instructions and active skill policies for every fresh Codex or
OpenCode invocation. The task and execution phase provide the specific context; there are no
role-specific agent or skill prompt files. Runtime-specific CLI flags, sandbox/permissions,
models, auth paths, and JSONL normalization remain in the TypeScript adapters. Keep secrets and
model/provider arguments out of canonical behavioral material.

Each session writes its response to a temporary plain text file outside the worktree. The runner
reads that file verbatim, posts it as the GitHub comment, stores it in the platform, and deletes
the temporary file. The worker drives the flow from one minimal outcome line and the optional PR
line at the top of the response (`Outcome: implemented|blocked|decomposed|requires_decomposition`
and `PR: <url>`, or `Review: pass|changes_requested` for review sessions).

## Updating agent runtime

Local Compose binds `AGENT_RUNTIME_HOST_PATH` read-only to `AGENT_RUNTIME_DIR`, so new development
sessions read host edits immediately. Production uses the runtime copied into the application
image, preventing a missing or stale host directory from hiding required files. Rebuild the image
to deploy production runtime changes. Existing sessions keep the prompt with which they started.

Validate edits before the next run:

```bash
bun test src/backend/test/runtime-instructions.test.ts src/backend/test/outcomes.test.ts
```

Rebuild only when TypeScript adapter code, dependencies, or the image itself changes.

## Codex configuration

The default tested configuration is:

```dotenv
AGENT_PROVIDER=codex
CODEX_MODEL=gpt-5.6-luna
CODEX_REASONING_EFFORT=max
CODEX_HOME=/data/codex-home
```

Each invocation is a new `codex exec --json` process using `workspace-write`, automatic approval
review, the configured model/reasoning, the assigned worktree, and the response file path. The
adapter does not resume an earlier thread. Auth persists in `codex_home`; the canonical runtime is
not stored there.

OpenAI documents `codex exec`, JSONL, output schemas, and sandbox flags in the official [Codex CLI
reference](https://developers.openai.com/codex/cli/reference). Account/device login, `CODEX_HOME`,
and headless credential-cache behavior are described in [Codex
authentication](https://developers.openai.com/codex/auth). Model IDs and reasoning options are in
the [latest model guidance](https://developers.openai.com/api/docs/guides/latest-model).

## Testing Codex

```bash
docker compose --env-file .env.production -f docker-compose.production.yaml exec worker codex --version
docker compose --env-file .env.production -f docker-compose.production.yaml exec worker codex login status
curl --fail http://127.0.0.1:18421/api/status
```

The definitive test is the disposable-repository E2E in **First deployment**. Confirm the job row
shows provider `CODEX`, model `gpt-5.6-luna`, reasoning `max`, a session ID, PR, and independent
review. A login-status check alone does not spend tokens and does not prove model access.

## OpenCode configuration

The default is:

```dotenv
AGENT_PROVIDER=opencode
OPENCODE_MODEL=opencode-go/deepseek-v4-flash
XDG_DATA_HOME=/data/opencode-data
OPENCODE_CONFIG_DIR=/data/opencode-config
OPENCODE_PERMISSION={"*":"allow"}
```

The adapter launches a fresh `opencode run --format json` process, sends the prompt on stdin, and
normalizes raw JSON events. `OPENCODE_PERMISSION` allows required noninteractive repository/GitHub
tools inside the already isolated worker container. Do not expose the Docker socket or unrelated
host directories to that container.

The default uses the [OpenCode Go](https://opencode.ai/docs/go/) subscription (`opencode-go`
provider) rather than pay-per-token API billing. Authenticate the provider inside the worker
container once and store its key in the persistent `opencode_data` volume:

1. Subscribe to OpenCode Go at [opencode.ai/auth](https://opencode.ai/auth) and copy the API key.
2. Run the login command from the online worker and select **OpenCode Go**:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yaml exec worker opencode auth login
   ```

3. Confirm the provider is available:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yaml exec worker opencode auth list
   docker compose --env-file .env.production -f docker-compose.production.yaml exec worker opencode models opencode-go
   ```

`OPENCODE_MODEL` uses the OpenCode Go model id format `opencode-go/<model-id>` (for example
`opencode-go/deepseek-v4-flash`). Set any `provider/model` that the authenticated provider exposes.

See the official OpenCode [installation](https://opencode.ai/docs/), [CLI](https://opencode.ai/docs/cli/),
[provider](https://opencode.ai/docs/providers/), and [model](https://opencode.ai/docs/models/)
documentation. DeepSeek announced the `deepseek-v4-flash` API model in its [V4 Flash release
notes](https://api-docs.deepseek.com/news/news260424/).

## Testing OpenCode

```bash
docker compose --env-file .env.production -f docker-compose.production.yaml exec worker opencode --version
docker compose --env-file .env.production -f docker-compose.production.yaml exec worker opencode auth list
docker compose --env-file .env.production -f docker-compose.production.yaml exec worker opencode models opencode-go
curl --fail http://127.0.0.1:18421/api/status
```

Run the same disposable issue E2E and confirm provider `OPENCODE`, model
`opencode-go/deepseek-v4-flash`, JSONL events, PR, and separate review. Model listing can require
network access and does not replace a real job.

## Switching agent provider

1. Finish/cancel currently active work. Queued jobs retain their provider/model snapshot and a
   worker claims only jobs matching its configured provider.
2. Complete the interactive login for the destination provider and verify its CLI as above.
3. Change only `AGENT_PROVIDER` plus the destination model setting in `.env.production`.
4. Recreate backend and worker:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yaml up -d --force-recreate backend worker
   curl --fail http://127.0.0.1:18421/api/status
   ```

5. Run a new scan. New jobs snapshot the newly selected provider/model. Old history remains
   unchanged. If unmatched queued jobs remain from the previous provider, switch back to drain or
   cancel/retry them deliberately.

## Telegram

Create a bot by messaging `@BotFather`; Telegram's official [bot tutorial](https://core.telegram.org/bots/tutorial)
describes token creation and requires a user to contact a private bot before it can message that
user. Send the new bot a message, then read the update in a trusted shell:

```bash
read -s TELEGRAM_TOKEN
curl --silent "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates"
unset TELEGRAM_TOKEN
```

Use `result[].message.chat.id` (groups/channels commonly use a negative value) as
`TELEGRAM_CHAT_ID`. Set all three values:

```dotenv
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=replace-me
TELEGRAM_CHAT_ID=replace-me
```

Recreate backend/worker and use the dashboard test action or:

```bash
curl --fail -X POST http://127.0.0.1:18421/api/notifications/test
```

The dashboard/API reports only configured/operational booleans. Delivery failures remain on the
event row as `notificationError` and do not undo job transitions. Telegram messages are HTML
escaped and capped at the platform's message length.

## Decomposition and automated review

If the implementation session says a parent cannot fit one coherent PR, the runner finishes the
implementation job and queues a separate `DECOMPOSITION` job. It starts a fresh provider session
with the same global instructions.
Children must include objective, current technical context, acceptance criteria, tests, and
dependencies. The agent creates GitHub issues, attaches native parent/sub-issue relationships when
the endpoint is available, and labels only dependency-free children ready. If native sub-issues are
unavailable, it links both directions and states the limitation. Artificial file-by-file splitting
is forbidden.

Review is a fully independent durable job. The PullRequestScanner creates a `REVIEW` job for a
specific PR and head SHA whenever it carries `agent:review-requested`; the review runner then retrieves the PR
metadata and the full diff from `develop`, starts a fresh provider session with the issue,
acceptance criteria/body, PR, diff, comments, and review history. The reviewer inspects available
GitHub Actions runs through `gh api` and reproduces `.github/workflows/ci.yaml` locally before its
verdict; the scheduler itself never calls the Checks API.
The reviewer writes a plain text response starting with `Review: pass` or `Review: changes_requested`.
The response is stored verbatim in `review` (linked to the review job and head SHA) and posted as a
PR comment. This is an automated review record, not an automatic merge or GitHub approval. A review
computed for a head SHA that no longer matches the PR head is discarded as stale and can never
finalize a newer head.

## Local development

Requirements: Bun 1.3.14, Python 3.11+, Docker/Compose, Git, GitHub CLI, and the selected provider CLI.

```bash
cp .env.example .env
bun install --frozen-lockfile
pip install -r requirements.txt
pre-commit install
pre-commit install --hook-type commit-msg
docker compose up -d postgres redis
DATABASE_URL=postgresql://swarmloom:swarmloom@localhost:17432/swarmloom bun run db:generate
DATABASE_URL=postgresql://swarmloom:swarmloom@localhost:17432/swarmloom bun run db:deploy
```

Put the real development GitHub token in the ignored `.env`, complete the selected provider login,
then start all processes:

```bash
bun run dev
```

Run deterministic unit tests without credentials:

```bash
bun --filter swarmloom-backend test
bun run typecheck
bun run lint
bun run build
```

Run PostgreSQL integration tests against the local Compose database:

```bash
APP_ENV=test NODE_ENV=test RUN_INTEGRATION=1 \
  DATABASE_URL=postgresql://swarmloom:swarmloom@localhost:17432/swarmloom \
  REDIS_URL=redis://localhost:18422 SETTINGS_ENCRYPTION_KEY=test-settings-encryption-key-0123456789 \
GITHUB_TOKEN=test-token GITHUB_REPOSITORIES=acme/app,acme/main-only AGENT_PROVIDER=codex \
bun --filter swarmloom-backend test
```

The integration suite uses fake GitHub/provider dependencies and local temporary Git repositories;
it does not spend model quota or mutate real GitHub repositories.

## Build, lifecycle, logs, and updates

```bash
# Build/rebuild
docker compose --env-file .env.production -f docker-compose.production.yaml build backend

# Start
docker compose --env-file .env.production -f docker-compose.production.yaml up -d

# Stop containers but keep every volume
docker compose --env-file .env.production -f docker-compose.production.yaml down

# Restart
docker compose --env-file .env.production -f docker-compose.production.yaml restart

# Health and logs
docker compose --env-file .env.production -f docker-compose.production.yaml ps
docker compose --env-file .env.production -f docker-compose.production.yaml logs --tail=200 backend worker frontend
```

After an update:

```bash
git pull --ff-only
docker compose --env-file .env.production -f docker-compose.production.yaml build backend
docker compose --env-file .env.production -f docker-compose.production.yaml up -d
curl --fail http://127.0.0.1:18421/api/health
```

The backend command runs `prisma migrate deploy` before starting. Never use `down -v` during normal
updates; it deletes named volumes.

## Backups and retention

Back up PostgreSQL and worker data before upgrades or manual worktree pruning:

```bash
mkdir -p backups
pg_dump "$DATABASE_URL" > backups/postgres.sql

docker compose --env-file .env.production -f docker-compose.production.yaml run --rm --no-deps \
  -v "$PWD/backups:/backup" backend \
  tar --exclude=codex-home --exclude=opencode-data --exclude=opencode-config \
  -czf /backup/worker-data.tgz -C /data .
```

Provider auth volumes contain credentials. If you back them up, encrypt the archive immediately
and restrict it like the original token; otherwise re-authenticate after losing those volumes.

Restore PostgreSQL only during a maintenance window:

```bash
docker compose --env-file .env.production -f docker-compose.production.yaml stop backend worker
psql "$DATABASE_URL" < backups/postgres.sql
docker compose --env-file .env.production -f docker-compose.production.yaml start backend worker
```

Never delete these without a tested backup: `postgres_data`, `worker_data`, `codex_home`,
`opencode_data`, and `opencode_config`. Keep `agent-runtime` in Git and on the mounted host path.

Worktrees are removed automatically once their job reaches a terminal state and leftover worktrees
from stale jobs are recovered at worker startup. To inspect capacity:

```bash
docker compose --env-file .env.production -f docker-compose.production.yaml exec worker du -sh /data/repositories /data/worktrees
docker compose --env-file .env.production -f docker-compose.production.yaml exec worker \
  git -C /data/repositories/OWNER/REPO worktree list
```

Remove a worktree manually only after its job is terminal and Git reports the exact path. Do not
recursively delete the data root or repository clone.

## Troubleshooting

### PostgreSQL or migrations

- PostgreSQL unavailable: check the external provider, `DATABASE_URL`, network access, and credentials.
- authentication failure: make the password embedded in `DATABASE_URL` match the Compose password;
  URL-encode special characters.
- migration failure: inspect `backend` logs and `prisma/migrations`; do not edit an already-applied
  migration. Restore a backup before corrective database work.

### GitHub authentication

- Run `docker compose ... exec worker gh auth status` and verify repository access with `gh api`.
- A 403 usually means repository selection or Issues/Contents/Pull requests permission is missing.
- Organization SSO or fine-grained token approval may need an organization administrator.
- Do not put the token into a Git remote URL; the worker uses an HTTP authorization header.

### Missing `develop`

The repository becomes `INVALID`, emits `REPOSITORY_INVALID`, and queues no issues. Create/push
`develop`, then Run now. The worker will not use `main` or `master`.

### Fetch, push, or Git permissions

- Confirm the VPS can resolve/reach `github.com` (or `GITHUB_API_URL`/enterprise host).
- Confirm Contents write and branch protection allow the token to push a new `agent/issue-*` branch.
- Confirm `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` are valid.
- A protected `develop` is fine because the worker does not push to or merge it.

### Worktree errors

- Inspect `git -C /data/repositories/OWNER/REPO worktree list` and the job's `worktreePath`.
- Paths from jobs still queued or running are expected. A path without a matching active job
  indicates stale/manual filesystem state; back it up and use `git worktree remove PATH` only after
  confirming the corresponding job is terminal.
- Check free disk space and ownership of `/data` before changing permissions.

### Codex authentication/runtime

- `codex login status` must succeed after completing the login from the online worker.
- Confirm `CODEX_HOME=/data/codex-home` and that `codex_home` is mounted into backend and worker.
- Re-run device login with `docker compose exec worker codex login --device-auth`.
- Verify the configured account can access `CODEX_MODEL`.

### OpenCode authentication/runtime

- Confirm `/data/opencode-data/opencode/auth.json` is present and contains the `opencode-go`
  provider after following **OpenCode configuration** above.
- Run `opencode auth list` and `opencode models opencode-go` in the worker container.
- Confirm the model is in `provider/model` format (for example `opencode-go/deepseek-v4-flash`) and
  that outbound access to provider/model catalogs is allowed.

### Telegram

- The bot/user must have an existing chat; for a group/channel, grant posting permission.
- Re-check the chat ID sign and token, then call `/api/notifications/test`.
- Inspect the event's `notificationError`; the job state still remains valid if delivery failed.

### Filesystem/volume permissions

The image runs as user `bun`. Named volumes are initialized with the image's `/data` ownership. For
local bind mounts, make the selected host directory readable by the container and keep
`agent-runtime` read-only. Do not solve a permission problem with world-writable secret/auth
directories.

### Provider mismatch after switching

Each job stores the provider/model snapshot captured at discovery. New scans use the values in
Settings, while the worker keeps both provider adapters available so switching does not strand
queued work.

## External verification gate

Unit and integration tests use fakes and prove lifecycle behavior without credentials. A real
Codex/OpenCode job necessarily requires operator-owned provider credentials, GitHub access, and a
disposable repository. Before trusting unattended production schedules, complete the E2E once with
each provider, inspect its PR/review/events, revoke any test-only token, and then add production
repositories.

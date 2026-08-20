<p align="center">
  <img src="src/frontend/public/brand/logo.png" alt="Swarmloom" width="720">
</p>

# Swarmloom

Swarmloom is a Dockerized TypeScript application that turns ready-labelled GitHub issues into
durable BullMQ jobs, runs them through interchangeable Codex or OpenCode sessions, opens
Pull Requests against the mandatory `develop` branch, and reconciles each managed Pull Request
through its own asynchronous lifecycle.

Implementation, fixing, and review are independent jobs. An agent never starts another agent
directly: each job performs one responsibility, publishes its result to GitHub (labels and comments
are the human-visible coordination protocol), and terminates. A single scheduler then reconciles the
observed GitHub state into the next job:

```text
Issue agent:ready
→ IMPLEMENTATION → PR (agent:review-requested)
→ REVIEW (inspect Actions and reproduce CI locally)
→ changes requested → PR agent:fix-requested → FIX → agent:review-requested → REVIEW
→ review pass → PR agent:review-passed, issue agent:ready-to-merge
→ human merge → issue agent:done
```

The Pull Request scanner discovers open PRs carrying a Swarmloom workflow label, records their
structured PR/issue association from the agent branch, and then reconciles them. It does not gate on
the GitHub Checks API. Every managed PR carrying
`agent:review-requested` receives an independent review for its exact head SHA. The reviewer reads
the PR and GitHub Actions context, reproduces the repository CI locally, and either passes or leaves
actionable changes. `Review: changes_requested` moves the PR to `agent:fix-requested`; the next scan
queues a `FIX` job on the same PR branch. The loop `REVIEW → changes requested → FIX → push → REVIEW`
continues until the review passes or a configurable safety limit (default five consecutive fix
cycles) blocks the workflow with
`agent:human-review`. Swarmloom never merges Pull Requests.

Every job refreshes the complete issue, comments, the linked Pull Request, diffs, and review threads
before the agent starts. The implementation agent runs the repository's verification suite locally
in the worktree before opening a Pull Request; the worker image bundles ephemeral local Postgres and
Redis servers (`swarm-test-services`) so integration tests run without Docker. CI state for the exact
PR head SHA is review evidence, not a scheduler gate.
If a job fails, Swarmloom records the failure and comments on the issue and Pull Request when
available. Opening a separate `agent:ready` diagnostic issue is disabled by default and can be
enabled from Settings.

It includes:

- multi-repository scheduled and manual discovery with two logical scanners (issues and pull
  requests) running from one scheduler;
- exact `origin/develop` baselines, isolated branches, and persistent Git worktrees;
- one BullMQ queue where the Job type (`IMPLEMENTATION`, `FIX`, `REVIEW`, `DECOMPOSITION`) and
  subject (`ISSUE`, `PULL_REQUEST`) express the behavior, with PostgreSQL as the durable
  business-state/history ledger and SQL-guarded duplicate prevention;
- Codex (`gpt-5.6-luna`, `max`) and OpenCode (DeepSeek V4 Flash) adapters;
- one provider-independent global instruction set under `agent-runtime`;
- shared frontend/backend skills installed globally in the image for Codex, OpenCode, and Claude Code;
- an operational dashboard and centralized optional Telegram notifications;
- one production image; local Compose provisions Redis for BullMQ while production Redis and PostgreSQL
  remain external services.

The worker never falls back to `main`/`master`, force-pushes, or merges Pull Requests.

## DevOps and commit policy

This repository follows the DevOps practice in `devops-automation-hub`: install the pinned Python
tooling from `requirements.txt`, install the pre-commit hooks, and run the same checks locally and
in GitHub Actions.

```bash
pip install -r requirements.txt
pre-commit install
pre-commit install --hook-type commit-msg
pre-commit run --all-files
```

Pull requests target `develop` and use the commit types in `git-conventional-commits.yaml`.
Before a commit, run `scripts/verify-before-commit.sh` (or
`/usr/local/bin/verify-before-commit` inside the application containers); it runs pre-commit,
typecheck, lint, and tests. Pushes to `main` run Semantic Release.

## Run locally

Requirements: Docker with Compose v2 and a GitHub fine-grained token. The target repositories must
have a `develop` branch; startup creates the configured worker labels automatically, as documented
in [DEPLOYMENT.md](DEPLOYMENT.md#github-token-and-labels).

```bash
cp .env.example .env
```

Edit `.env`: replace `GITHUB_TOKEN`, `SETTINGS_ENCRYPTION_KEY`, and `GITHUB_REPOSITORIES`, then choose one provider. The local Compose Redis URL is already configured. Build and start the shared image:

```bash
docker compose build backend
docker compose up -d
docker compose ps
```

Then log in once with the selected provider (see [Provider login](#provider-login)). Run only the
applicable command:

```bash
# Codex: keep AGENT_PROVIDER=codex
docker compose exec worker codex login --device-auth

# Or OpenCode: set AGENT_PROVIDER=opencode
docker compose exec worker opencode auth login

curl --fail http://127.0.0.1:18421/api/health
```

Open <http://localhost:18420>. Follow or stop the application with:

```bash
docker compose logs -f backend worker
docker compose stop
```

`docker compose stop` preserves PostgreSQL, provider login caches, repositories, and worktrees.

After the first start, operational values such as repositories, labels, schedule, concurrency,
provider/model, and Telegram are managed from **Settings**. Telegram secrets are encrypted before
being stored in PostgreSQL and never returned by the API.

## Provider login

Start the stack first, then log in once per environment with the selected provider. The session is
stored in a named Docker volume and survives container recreation; `docker compose down` keeps it.
Run only the commands for the provider set in `AGENT_PROVIDER`.

The commands below use the local Compose file. On a server, add
`--env-file .env.production -f docker-compose.production.yaml` to every command.

### Codex

Requires a Codex CLI account; authentication uses the device flow.

```bash
docker compose exec worker codex login --device-auth
```

Open the device URL shown in the terminal and approve. The session is stored in the `codex_home`
volume mounted at `CODEX_HOME`. Verify:

```bash
docker compose exec worker codex login status
```

### OpenCode

Requires an OpenCode Go subscription: subscribe and copy the API key at
<https://opencode.ai/auth>.

```bash
docker compose exec worker opencode auth login
```

Select **OpenCode Go** and paste the API key. The session is stored in the `opencode_data` volume
mounted at `XDG_DATA_HOME`. Set `OPENCODE_MODEL` to a `provider/model` id exposed by the
authenticated provider, for example `opencode-go/deepseek-v4-flash`. Verify:

```bash
docker compose exec worker opencode auth list
docker compose exec worker opencode models opencode-go
```

### Verify the selected runtime

```bash
curl --fail http://127.0.0.1:18421/api/status
```

The containers stay online while provider authentication is pending. A login-status check does not
prove model access: run one disposable-issue end-to-end job as described in
[DEPLOYMENT.md](DEPLOYMENT.md#first-deployment).

## Deploy on a server

The recommended boundary is a Linux VPS with Docker/Compose and SSH access. Put the code in a
private Git repository, then on the server:

```bash
git clone YOUR_PRIVATE_REPOSITORY_URL swarmloom
cd swarmloom
cp .env.production.example .env.production
chmod 600 .env.production
```

Edit `.env.production` and replace every placeholder. At minimum configure the externally managed
`DATABASE_URL`, `SETTINGS_ENCRYPTION_KEY`, `GITHUB_TOKEN`, and `GITHUB_REPOSITORIES`, then select
`AGENT_PROVIDER`. Set `REDIS_URL` to the externally managed Redis/Valkey endpoint. For access through SSH, use:

```dotenv
FRONTEND_URL=http://localhost:18420
PUBLIC_API_URL=http://localhost:18421
```

Validate and build the deployment:

```bash
docker compose --env-file .env.production -f docker-compose.production.yaml config --quiet
docker compose --env-file .env.production -f docker-compose.production.yaml build backend
```

Start the stack:

```bash
docker compose --env-file .env.production -f docker-compose.production.yaml up -d
docker compose --env-file .env.production -f docker-compose.production.yaml ps
```

Then log in once with the selected provider (see [Provider login](#provider-login)). Run only the
applicable login, verify it, and check the deployment:

```bash
# Codex
docker compose --env-file .env.production -f docker-compose.production.yaml exec worker codex login --device-auth

# Or OpenCode
docker compose --env-file .env.production -f docker-compose.production.yaml exec worker opencode auth login

curl --fail http://127.0.0.1:18421/api/health
```

The production ports bind only to server loopback. From your workstation, open an SSH tunnel and
then visit <http://localhost:18420>:

```bash
ssh -L 18420:127.0.0.1:18420 -L 18421:127.0.0.1:18421 USER@SERVER
```

For a public hostname, keep the Compose ports private and put an authenticated TLS reverse proxy
in front: route `/api/*` to `127.0.0.1:18421` and everything else to `127.0.0.1:18420`; set both
URLs in `.env.production` to that HTTPS origin before building. See [DEPLOYMENT.md](DEPLOYMENT.md)
for token permissions, labels, interactive provider login, first end-to-end job, backups, updates,
and troubleshooting.

## Quality checks

```bash
bun install --frozen-lockfile
docker compose up -d postgres redis
bun run typecheck
bun run lint
bun run test
bun run build
pre-commit run --all-files
```

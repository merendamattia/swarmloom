# Performance measurements

## Job evidence, 2026-11-03

Baseline: `cd41a349c439bb1f2be33575d178d6b1c57c9700`. Measurements used macOS
arm64, Bun 1.4.4 and an isolated PostgreSQL 17 container over loopback. Each
of three independent trials seeded 300 events with an 8 KiB random JSON value
in each of `metadata` and `raw`. Thirty events contained agent output. Each
trial discarded five warm-up requests and measured twenty sequential requests
through the actual Hono application. External providers were excluded.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Response bytes | 5,019,309 | 56,109 |
| p50, trial 1 | 21.30 ms | 2.04 ms |
| p50, trial 2 | 18.98 ms | 1.92 ms |
| p50, trial 3 | 19.65 ms | 1.88 ms |
| p95, trial 1 | 23.48 ms | 2.68 ms |
| p95, trial 2 | 19.94 ms | 3.05 ms |
| p95, trial 3 | 21.54 ms | 2.05 ms |

The response is about 98.9% smaller on this fixture. These warm local numbers
measure database reads and response serialization, not production network
latency or provider execution. A job with small event payloads will save less.
Functional checks also run with the application's pinned Bun 1.4.4 image.

The job repository projects timeline fields in PostgreSQL. It reads metadata
only for `JOB_RESUME_REQUESTED` and `SESSION_RESUMED`, which establish whether
the current retry resumed its session. Every event remains in chronological
order. Full provider payloads remain in PostgreSQL for diagnostics and history.
The HTTP route retains environment scoping and public response serialization.

To reproduce against an isolated, migrated test database, set the same required
environment variables as `.github/workflows/ci.yaml`, pointing `DATABASE_URL`
and `REDIS_URL` at dedicated local test services, then run:

```sh
bun run db:generate
bun run db:deploy
for trial in 1 2 3; do
  bun scripts/benchmark-job-detail.ts candidate
done
```

Run the same harness on the baseline checkout for comparison. Keep runtime,
database, fixture and cache conditions identical. Run benchmarks separately
from integration tests: both create temporary repository records. The harness
requires `APP_ENV=test`, reports the runtime and removes its fixture afterward.

## CI baseline and decisions

The comparable successful runs on `b7d421e72d6aeafeac7023c45c73d638c0395235`
used GitHub-hosted `ubuntu-latest` runners. The baseline was collected from
Actions runs `41615629233`, `41615629241` and `41615629483`.

| Dominant work | Observed time | Change |
| --- | ---: | --- |
| Production image build | 204 s | Buildx with GitHub Actions layer cache; load the built image into Docker for all existing Compose smoke checks. |
| Pre-commit in quality | 13 s | Cache Python 3.11 hook environments by OS, architecture and hook configuration. |
| Separate pre-commit gate | 12 s | Reuse the same hook environment cache. |
| Frontend/backend build | 26 s | Retain the complete build gate; measure cache changes before adding another archive. |

The Docker push run `41615619184` took 197 s for its build; this illustrates
run-to-run variation rather than a candidate improvement. The quality job took
91 s overall, and Docker took 219 s overall. These jobs run in parallel; their
durations must not be added to estimate user waiting time. No self-hosted
runners were registered during the audit.

The retained `docker-container` builder at `113ad9c` took 602 s on its first
run without an existing cache and 111 s on a repeat run reusing exported layers
(run `41621777488`, attempts 1 and 2). The build step took 563 s and 92 s,
respectively. On the repeat run, cache export took 1.6 s while exporting and
loading the image took 87.9 s. The first cache population is an extra cost, not
a speedup. These are individual observations, not population latency
statistics.

A native Docker/containerd variant was also tested at `96cbbb4`, with the same
image inputs and available layer cache (run `41624162131`). Its build step took
84 s, but setup/cleanup and the full smoke checks brought the whole job to
121 s. It did not demonstrate an additional net saving over 111 s, so the
extra daemon configuration was removed. The simpler cached builder is retained.

### Weekly cache reuse

GitHub scopes cache entries created by a pull request to its merge ref, so
another PR or a push to `develop` cannot reuse those entries. The first push to
`develop` after enabling Buildx therefore seeded a separate branch cache: its
image build took 518 s and its complete Docker job 557 s (run
`41627289775`). The same PR-scoped export would not have helped that push.

Commit `acb1374` keeps `cache-from` on pull requests but writes `cache-to` only
for pushes to `develop`. This keeps one reusable branch cache and avoids
creating isolated cache entries for each PR. One earlier PR ref accumulated
1.78 GB of cache entries in this audit; this is stored cache size, not a
measured transfer amount. The first verification run on PR `#171` restored the
cache written to `develop`, created no entries under `refs/pull/171/merge`, and
completed the image build in 89 s and the full Docker job in 122 s (run
`41642638183`). Against the baseline job's 219 s, this saves 97 s on that
observed cache-reusing PR run. If a weekly run continues to hit the branch
cache, four such runs recover the 338 s one-time `develop` cache-seeding cost.

At measurement time, the repository held 7.4 GB across 134 cache entries, with
a 10 GB storage limit and a 7-day maximum retention. GitHub removes caches
that have not been accessed for over 7 days. A weekly workflow run can refresh
the branch cache before expiry, but a delay beyond that window can require
another seed. These are individual runner observations, not guarantees.

When no cache exists, every original install/build/check still runs. Evaluate
the first cache population separately from recurring runs that reuse it.
Superseded validation runs
are cancelled per workflow and PR/ref; release publishing has its own workflow.

Local agent skill directories are excluded from Git and Docker context. Their
upstream formatting is excluded from application hooks. The application image
continues to use its existing build-time agent toolchain installation.

## Verification scope

The API regression covers public event fields, retained recovery metadata,
chronological ordering, full payload preservation in PostgreSQL and a request
for a job in a different environment. The benchmark also checks that all 300
events are returned. Existing retry tests cover the recovery label behavior.

Browser verification uses the real production UI and API with synthetic GitHub
startup/authentication and isolated database fixtures. Chromium, Firefox and
WebKit exercise job navigation, visible agent output, confirmed session recovery
and horizontal overflow at 1440 px and 390 px. Screenshots require visual
inspection in addition to those assertions.

The product has an operational dashboard rather than an authored demo scene.
Its existing design remains the visual acceptance reference; adding a simulated
walkthrough would be a separate product feature. Provider execution, durable
job transitions and queue ownership remain governed by their existing tests.

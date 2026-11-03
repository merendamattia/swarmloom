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
| p50, trial 1 | 21.30 ms | 1.93 ms |
| p50, trial 2 | 18.98 ms | 1.98 ms |
| p50, trial 3 | 19.65 ms | 1.79 ms |
| p95, trial 1 | 23.48 ms | 2.64 ms |
| p95, trial 2 | 19.94 ms | 2.28 ms |
| p95, trial 3 | 21.54 ms | 2.13 ms |

The response is about 98.9% smaller on this fixture. These warm local numbers
measure database reads and response serialization, not production network
latency or provider execution. A job with small event payloads will save less.
Functional checks also run with the application's pinned Bun 1.3.14 image.

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

Cache misses run every original install/build/check. Cache save/restore cost
and cold versus warm remote results must be evaluated on the candidate's
actual Actions runs before claiming a CI speedup. Superseded validation runs
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

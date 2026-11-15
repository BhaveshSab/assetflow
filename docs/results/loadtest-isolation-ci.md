# Load-test ownership and isolation — CI results

Evidence classes: EXECUTED / CI / REPORTED / BLOCKED / NOT RUN.

## Outcome (CI)

Job **Load-test fixture isolation (real PostgreSQL, synthetic)** at `6f7cbfe`:

```
passed=14 failed=0 skipped=0 overall=PASS
```

All seven workflow checks green: backend, frontend, infra, performance,
restore-integration, loadtest-isolation.

Real PostgreSQL 16, the real migration image, the real seed script. Nothing
touched AWS, production or any credential. This is **not** a performance
measurement and it does **not** open the live-load gate.

## The defect this fixed

The fixture was shared. Every run created `loadtest-001@assetflow.test` onward,
so:

- a second concurrent run **overwrote the first run's password**, and the first
  run's virtual users then failed to sign in;
- `--delete` removed whichever rows matched, **possibly another live run's**;
- nothing tied the seeded database to `BASE_URL`, so a run could seed one
  database and measure another — every request a 401, reported as the stack
  failing.

## What the 14 cases establish

| Case | Assertion |
|---|---|
| build migrate image | the real `Dockerfile.api --target migrate` builds |
| postgres ready | a real TCP query, not `pg_isready` |
| prisma migrate deploy | real migration history applies |
| seed a run's fixture | 3 accounts, run-scoped names |
| **two concurrent runs stay separate** | a=3, b=2 — neither overwrites the other |
| **no shared identities created** | `loadtest-001@` is absent |
| reseed of an owned run is refused | refuses and says why |
| seed without a run id is refused | exit non-zero |
| malformed run id is refused | exit non-zero |
| **delete removes only the named run** | a=0, b=2 untouched |
| delete of an unknown run spares others | b=2 intact |
| assets carry the run id | 5 tagged |
| delete removes the run's assets | accounts and assets gone |
| no fixture resources leaked | containers=0 volumes=0 networks=0 |

The refusals matter as much as the successes: a deletion path that cannot refuse
is a deletion path that will eventually delete the wrong thing.

## The four gaps and how each is closed

1. **Run ownership.** Every account and asset is named after its run
   (`loadtest-<run>-001@…`, tag `LT-<run>-000001`). `--run-id` is required and
   validated; deletion uses the exact per-run prefix, never a wildcard, so it
   cannot sweep a neighbouring run. Reseeding an owned run id refuses rather than
   silently adopting someone else's rows.

2. **Target binding.** The binding proof is a sign-in as a run-owned account whose
   password was generated seconds earlier — only the fixture's own database can
   satisfy it. It runs for single-user mode too, because it is about *which
   system* is measured, not about identity.

3. **Abort.** Crossing p95/error thresholds means the stage bent, which is the
   measurement and must not stop the run. A failure rate past
   `ABORT_ERROR_RATE` (0.5) means the target is *failing*: k6 stops the stage
   (`abortOnFail`), the verdict reads `ABORTED`, and the report states those
   numbers are partial and not a capacity figure.

4. **Failure-safe cleanup.** The trap is registered before the seed, so an
   interrupted seed, a failed stage or a Ctrl-C all remove this run's rows.

## Two bugs the first real CI run caught

- The leak check observed the harness's own live database (`containers=1
  volumes=1 networks=1`) because it ran before teardown. It now tears down first,
  then checks.
- The harness built its run id with `date +%z`, which emits a trailing
  upper-case `Z`. The seeder accepts only `[a-z0-9-]`, so the harness was
  generating ids its own seeder rejects. Found by testing the generator against
  the validator rather than trusting it.

## Safeguards still in place (EXECUTED)

- live load still refuses, even with `ALLOW_PRODUCTION_LOAD_TEST=yes`
- `--dry-run` planning still works
- all three destructive rebuild phases still refuse
- only the gate's *wording* changed, to state what actually remains: review

## What this does not establish

- any AWS measurement, capacity figure or cost
- production recovery time, RPO or RTO
- that the live-load gate should open — that is a review decision, not a test result

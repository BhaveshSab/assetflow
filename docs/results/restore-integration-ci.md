# Isolated restore integration — CI results

Evidence classes: EXECUTED / CI / REPORTED / BLOCKED / NOT RUN.

## Outcome (CI)

Run on the PR #31 branch at `2c356ab`, workflow CI, job
**Restore integration (real PostgreSQL, synthetic)**.

```
passed=16 failed=0 skipped=0 overall=PASS
```

All steps green, including lint, the harness run, the summary publish, the
artifact upload and the leftover-resource sweep.

This is a **CI integration result**. It is **not** an AWS performance
measurement, **not** a capacity claim, and **not** production recovery evidence.
Every database here is disposable and locally created; no production service,
credential or AWS API was contacted.

## What the 16 cases establish

| Case | Assertion |
|---|---|
| build migration image | the shipped `Dockerfile.api --target migrate` builds |
| postgres ready | real query over TCP, not just `pg_isready` |
| prisma migrate deploy (source) | the real migration history applies |
| seed synthetic data | 2 users, 1 asset, 1 booking |
| constraint SQL contract (real pg) | 8 assertions against a real catalog |
| dump current release | `pg_dump -Fc` of the seeded database |
| build older backup | a backup whose constraint migrations are absent |
| current backup restores and verifies | exit 0 |
| older backup migrates forward and verifies | exit 0 — migrations repair an older schema |
| corrupt dump is refused | exit 1 |
| dump without checksum is refused | exit 1 |
| misnamed checksum sidecar is refused | exit 1 |
| migration history mismatch is refused | exit 1 |
| constraints missing despite applied history is refused | exit 1 |
| interrupted run cleans up | SIGTERM leaves nothing |
| no restore resources leaked | containers=0 volumes=0 networks=0 |

The five refusal cases matter as much as the two success cases: a verification
step that cannot fail is not a verification step.

## The constraint fix, verified against real PostgreSQL

The shipped `restore-constraints.sql` canonicalized `pg_get_constraintdef()` by
stripping whitespace and parentheses but **keeping double quotes**. PostgreSQL
only quotes an identifier when it must; for these lowercase, non-reserved columns
it renders them unquoted. The hand-written literal therefore could not match the
rendered text, and the check would have failed against a *correct* restored
database — the worst possible failure mode, because it reads as "the backup is
bad".

Fixed by stripping quotes as well in all four `regexp_replace` calls and
dequoting the four literals. Assertions kept exactly: constraint kind, column,
operator, row filter, enum type and predicate, plus `indisvalid`, `indisready`
and `indisunique`.

Verified against a real PostgreSQL 16 built by the real migrations: the shipped
check returns `t`. Then each assertion is proven able to fail, by mutating the
object it guards and confirming `f`, and restoring the object and confirming `t`
again:

- EXCLUDE constraint dropped
- EXCLUDE predicate widened to include CANCELLED
- CHECK constraint dropped
- partial unique index dropped
- unique index recreated as non-unique
- `btree_gist` extension removed

8 assertions on the real catalog, all as expected.

## Two real defects the integration found

1. **Readiness raced initdb.** `restore-verify.sh` waited on `pg_isready`, which
   can answer against the *temporary* server initdb runs on the unix socket
   before it restarts. A fast runner broke out early and the next command saw
   "the database system is shutting down". Readiness is now a real query over
   TCP to the target database, which cannot succeed before the server every
   later step needs is up. Stricter, not looser: it also stops waiting as soon
   as the container has exited. A unit test pins the gate.

2. **Cleanup raced container release.** Removing a container returns before the
   kernel has necessarily released its volume, so an immediate `docker volume rm`
   can fail with "volume is in use" — likely precisely when a run was
   interrupted. `cleanup()` now retries each removal and treats the steps
   independently, so one failure cannot skip the rest. Only resources this run
   created are touched.

Neither change removes, weakens or bypasses a safeguard.

## Safeguards still in place (EXECUTED)

- live load execution still refuses, even with `ALLOW_PRODUCTION_LOAD_TEST=yes`
- `--dry-run` planning still works
- all three destructive rebuild phases still refuse
- production origins still refused in every tested spelling, including
  `https://operator@13.55.90.25`

## Not established by this job

- any AWS measurement, capacity figure or cost
- production recovery time, RPO or RTO
- that the real production backup restores (only synthetic dumps were used)
- TLS, DNS or public reachability
- the load-testing and rebuild gates are **not** implemented; they remain OFF

## Prerequisites for the approved AWS measurement run

The integration proves the tooling and the database contract. It does not
authorise or measure a production run. Before any approved AWS performance
measurement, the following must be settled — each is an explicit decision, not a
task that can be assumed:

1. **Written approval naming the run.** Which target (production, or a separate
   approved stack), which window, and who is on call.
2. **Load generator ownership and isolation.** The load gate stays ON until
   run-owned fixtures, explicit target binding, generator/target separation,
   abort conditions and failure-safe cleanup are implemented and reviewed. A
   denylist is not isolation.
3. **Accepted production impact.** A saturation run bends the stack it targets.
   Documented expectation of user-visible impact during the window, or a
   decision to measure a disposable stack instead.
4. **Cost approval.** Instance hours, any temporary larger instance, and data
   transfer, with a stated budget ceiling.
5. **Baseline captured first.** Current deployed image identity, current
   latency/error baseline, and current row counts, so the measurement has a
   reference.
6. **Monitoring and alerting armed.** Real metrics and a Telegram alert that is
   known to fire *and* resolve, so a saturation run is observed rather than
   guessed at.
7. **Rollback ready.** A known-good previous release and the exact steps to
   return to it, without relying on the rebuild path that is still gated.
8. **A decision on k6 provenance.** The pinned k6 digest was carried over from
   the earlier patch, not independently fetched here; verify it before use.
9. **Data safety.** Synthetic or approved test data only; no personal data in a
   load fixture.
10. **Recording of results.** Where the numbers will be written, and the explicit
    statement that a CI integration result is not a capacity result.

Until items 1–6 are decided, no AWS measurement run should start.

# Isolated restore verification: findings and current state

Evidence classes: EXECUTED / CI / REPORTED / BLOCKED / NOT RUN.

## Defect found and fixed in this pass (EXECUTED)

### `restore-constraints.sql` could never pass against a correct database

The constraint check canonicalized PostgreSQL's rendering with

```sql
regexp_replace(pg_get_constraintdef(c.oid), '[[:space:]()]', '', 'g')
```

which strips whitespace and parentheses but **keeps double quotes**.
`pg_get_constraintdef()` renders a quoted column reference as `"status"`, so the
real canonical form is

```
EXCLUDEUSINGgistassetIdWITH=,tsrangestartTime,endTimeWITH&&WHERE"status"<>'CANCELLED'::"BookingStatus"
```

while the hand-written literal was

```
EXCLUDEUSINGgistassetIdWITH=,tsrangestartTime,endTimeWITH&&WHEREstatus<>'CANCELLED'::"BookingStatus"
```

Those differ by two characters, so `[ "$constraints_ok" = t ]` would have been
false and every restore — including a perfectly good one — would have died with
"Allocation_one_active_per_asset / Booking_no_overlap definitions or validity do
not match this release". A verification step that cannot pass is worse than no
step: it would have been read as "the backup is bad".

Fix: strip `"` as well as whitespace and parentheses, on all four
`regexp_replace` calls, and drop the quotes from the four literals. Identifier
quoting is formatting; the identifiers themselves are already fixed by the
schema. Every semantic assertion is retained — constraint kind, column, operator,
row filter, enum type, predicate, plus `indisvalid`/`indisready`/`indisunique`.

This does **not** weaken the check: the same values are still required exactly.

### Regression coverage (EXECUTED)

Added `test_constraint_literals_survive_pg_get_constraintdef_quoting` in
`infra/tests/test_audit_safety.py`. It reconstructs the rendered text from the
migrations, canonicalizes it, and requires the literals in the SQL file to match.

Proven to be a real regression test, not a tautology:

| SQL file state | Result |
|---|---|
| old canonicalizer `'[[:space:]()]'` | **FAIL** (`1 != 3` / literal mismatch) |
| fixed canonicalizer `'[[:space:]()"]'` | **PASS** |

## Linux suite after the change (EXECUTED)

Real Ubuntu 26.04, Python 3.14.4, clean clone at PR head `9702366` plus this fix:

```
Ran 94 tests in 10.910s
OK (skipped=1)
```

94 collected, 93 passed, 1 skipped, 0 failed. `bash -n` passes on all 16 scripts.

The single skip remains the Docker-dependent real-Compose test
(`test_real_compose_exec_without_tty_cannot_consume_script_payload`).

## Docker / PostgreSQL / Prisma integration (BLOCKED)

This is the next required gate and it **cannot be run on this machine**:

| Requirement | State on this host |
|---|---|
| Docker CLI / daemon (Windows) | not installed; no `Docker Desktop` directory |
| Podman / nerdctl | not present |
| `/var/run/docker.sock` in WSL | absent |
| Installing Docker in WSL | `sudo` requires an interactive password |
| PostgreSQL 16 (`psql`/`initdb`) | not installed; installing needs the same password |

So the following remain **NOT RUN**, and no result here should be read as evidence
for them:

- current-backup and older-backup restores against real PostgreSQL 16
- real `pg_get_constraintdef` / `pg_get_indexdef` formatting at runtime
  (the fix above is validated against reconstructed text, not a live server)
- actual Prisma `migrate deploy` against a restored database, and
  `_prisma_migrations` history/checksum agreement
- run-owned internal Docker network, volume and container isolation
- interruption (SIGINT/SIGTERM) and owned-resource cleanup
- corrupt / misnamed `.sha256` sidecars against real `pg_restore`

The unit tests model this orchestration with stubs; that models the flow, it does
not establish database correctness.

## Safeguards unchanged (EXECUTED on this PR head)

- live load execution still refuses, even with `ALLOW_PRODUCTION_LOAD_TEST=yes`
- `--dry-run` planning still works
- all three destructive rebuild phases (`teardown`, `rebuild`, `all`) still refuse
- production origins still refused in every tested spelling, including
  `https://operator@13.55.90.25`

No gate was removed, relaxed or bypassed in this pass.

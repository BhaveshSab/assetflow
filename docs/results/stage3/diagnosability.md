# Making Stage 3 diagnosable, without launching anything

No AWS resource was created, no ingress was opened, no IAM was changed, no
production system was touched, and no load test was run.

## The problem this addresses

Attempt 4 proved the migration gate works and then lost the reason its fixture
step failed. `GetConsoleOutput` is a fixed-size ring buffer, and ~58 minutes of
Docker layer output had already evicted the failure before anyone could read it.
Re-reading did not recover it.

So the next run's failure must be readable *while it happens* and must survive
the instance disappearing. That is a different problem from the migration
defect, and it needs its own fix.

## What was built

**`infra/capacity-run/bootstrap-status.py`** — an authenticated, read-only
endpoint started in the prelude, before packages, builds, migrations and
seeding. It serves four snapshots and nothing else:

| Path | Content |
|---|---|
| `/status` | stage, stage start, deadline state, disk, memory |
| `/status/seed` | seed exit code, signal, elapsed seconds, accounts seen |
| `/status/host` | disk and memory alone |
| `/status/failure` | bounded, redacted failure summary and seed log tail |

It never serves a file, a directory, the run directory, or an arbitrary path.
Every field passes through `redact()`, and every body is capped at 8 KiB.

`application_ready` is always `false`, and the payload says so explicitly:
the endpoint answering means the guest is alive and reporting, never that the
application works.

**Reachability before the application exists.** It listens on loopback 9444 and
is proxied by the same single-port TLS edge as everything else, matched on
`/status` *before* the catch-all so it cannot be shadowed. The unit is ordered
after `network-online.target` only — deliberately not after Docker or the app,
because it must answer while the app is broken or absent. No new public port.

**`infra/capacity-run/poll-status.sh`** — the operator side. Polls all four
endpoints and writes timestamped snapshots to disk for the whole life of the
run, verifying the certificate against the run CA with no `-k`. If nothing was
retrieved it exits 1, so "no snapshot" is never reported as success.

**`infra/capacity-run/seed-fixtures.sh`** now records `seed-exit`,
`seed-elapsed` and `seed-signal` before and after the seed, and keeps the log on
success as well as failure. A seed killed by OOM therefore leaves an exit status
even though it produced no output of its own.

**`infra/capacity-run/migrate-db.sh`** now waits for PostgreSQL to accept
queries before migrating. `up -d` returns when containers are *started*, not
healthy, and the migration uses `--no-deps`, so compose never waited for the
healthcheck — the gate could migrate into the gap where Postgres has bound its
port but cannot authenticate yet. That gap produces exactly the `P1001: Can't
reach database server` observed in CI. The wait is bounded (`DB_WAIT`, 180 s) and
failing to become ready is fatal.

## Proven, by execution

**368 unit tests pass in a clean clone** (5 additional errors in the Windows
worktree are the documented `git rev-parse` limitation and do not occur in a
clone). The 47 new tests in `infra/tests/test_bootstrap_status.py` cover:

- redaction of URL userinfo, `*_PASSWORD=` assignments, bearer tokens, JSON
  password hashes and private key blocks;
- credential-shaped text cannot reach any snapshot;
- the endpoint answers with the application absent;
- a missing token and a wrong token both get 401;
- a certificate for an unrelated name, and an untrusted CA, both fail
  verification — proving verification is not disabled;
- `/private.env`, `/evidence/seed.log` and `/../evidence/...` all get 404;
- seed exit code, elapsed time and progress are reported, and an unstarted seed
  says `not-started` rather than nothing;
- `/status` is routed before the catch-all and only one port is listened on;
- the migration gate waits for `pg_isready` before migrating.

The tests found three real defects while being written: the redaction pattern
missed every prefixed name such as `LOADTEST_PASSWORD=`, bearer masking left the
token itself in the output, and `evidence.env` was written *after* the unit that
reads it.

**CI run `42870366848` at `61b9167f16b3a1a1a4c62b069c268d2b41f48955`: 7/7 jobs
green, 20/20 capacity steps.** Two steps are new and both pass by execution:

- *Serve bootstrap status before the application is up* — starts the endpoint
  with the API not running, asserts `application_ready is False`, asserts 401
  for missing and wrong tokens, asserts a retained redacted failure snapshot,
  asserts the seed exit code `137` and elapsed `61s` are readable, and asserts
  the run directory returns 404.
- *A long seed exposes progress and a failed seed retains its exit status* —
  runs a real 500-account seed in the background and polls **while it is still
  running**, then stops PostgreSQL and requires the failed seed to leave a
  redacted exit status behind.

One earlier attempt at that second step failed honestly: a 300-account seed
finished before the first poll, and the step refused to pass rather than claim a
property it had not shown. The seed also caps at 500 accounts, which surfaced as
a hard error when 3000 was asked for.

## What this still does not prove

Nothing here has run on a t3.micro. The endpoint is proven to answer before the
application in CI on larger hardware; that CI success is not evidence about
micro performance or about the guest's real prelude. The performance question
(item 5, compilation cost) is analysed below and is not solved.

## Compilation versus the measurement baseline

The on-host build took ~58 minutes on a credit-throttled t3.micro, spending the
run's CPU credits on compiling rather than on the measurement. A prebuilt-image
deployment would remove that:

1. CI builds from the exact tested commit and records the immutable image
   digest (`docker inspect --format '{{index .RepoDigests 0}}'`) alongside
   `git rev-parse HEAD`.
2. The guest pulls by digest, never by `latest`, and verifies the digest
   against the value recorded at build time. A floating tag cannot be
   substituted because the digest is checked.
3. Retrieval without long-lived credentials: the repository is public, so an
   anonymous pull needs no credential at all. If images were private, the
   minimum decision needed is a read-only pull token delivered in the
   already-provisioned run configuration — *not* an instance role and not new
   IAM, both of which remain out of scope.

The minimum decision this requires: whether images may be published to a public
registry from CI. That is a supply-chain decision, not a technical one, so it is
raised rather than implemented.

## AWS inventory (read-only)

0 run-owned instances · 0 run-owned volumes · 0 run-owned elastic IPs ·
`cap-20261109t0800z-a7f3-sg` inbound rules **0** · production
`i-0ff4690ec52d0dc01` running at `13.55.90.25`. All four attempts remain on
record.

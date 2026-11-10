# The fixture-seeding failure: proven root cause and fix

Attempt 3 stopped in fixture seeding. This records what the seed actually failed
on, why CI never saw it, and what changed. No fourth instance was launched.

## The evidence that settled it

Two facts together name the cause.

First, the seeding command is not at fault. Running the bootstrap's **exact**
invocation in CI against the real migrate image, with the same 200 users and the
same password handling, exits 0. Whatever failed on EC2 was not the arguments.

Second, the console for attempt 3 shows what the bootstrap actually did in its
deploy stage:

```
[  825.400167] Image ghcr.io/bhaveshsab/assetflow-migrate:latest Pulled
[  826.370365] Container assetflow-migrate-1 Creating
[  829.005719] Container assetflow-migrate-1 Started
[  829.080700] capacity-bootstrap: stage-begin: fixtures
```

The **migrate container started at 829.005 and seeding began at 829.080** — 75
milliseconds. No migration ran. `up -d migrate` had no image to build from, so
compose pulled `ghcr.io/...:latest`, a prebuilt image from a different revision.

Seeding then ran against a schema that did not match the checked-out code and
failed in 37 seconds. That is far too fast for the ~56 s of bcrypt work 200
accounts require, which is what ruled out a timeout or resource limit.

## Why CI passed and the bootstrap failed

| | CI | Bootstrap (attempt 3) |
|---|---|---|
| builds images | `docker compose build api migrate nginx` | **never built** |
| migrate image | built from the checked-out commit | **pulled `ghcr.io/...:latest`** |
| migration outcome | applied against the current schema | nothing applied, container exited 0 |
| seeding result | 200 accounts | failed in 37 s |

Both ran what looked like the same command. The difference was entirely in what
happened before it, and neither command said "build first".

## What changed

1. **Build before use.** `docker compose build api migrate nginx` runs before any
   container is started.
2. **Pin run-local tags** (`assetflow-migrate:<run-id>` etc.). A run-local tag
   cannot be pulled from a registry, so the build is not optional.
3. **Require migration evidence.** `migrate.log` is captured and must show an
   applied migration or a current schema; a container that exits 0 without doing
   work is no longer trusted.
4. **One shared seeding path.** `infra/capacity-run/seed-fixtures.sh` is called by
   both CI and the bootstrap. Two inline copies are what drifted; there is now one.
5. **Hashes, not just rows.** The helper refuses to report success if any fixture
   account has no stored password, because a count does not show an account can
   sign in. CI additionally signs in through the real API with a generated
   credential, and a wrong password is proven to fail that check.
6. **Bounded, redacted failure output.** On failure the exit status and a
   redacted first/last 25 lines reach the console; the raw log stays private with
   mode 600. Redaction is tested against connection strings, password
   assignments, bearer tokens and password hashes.

## Verified

* Shared helper: 20 tests, including missing password, unreachable database,
  non-numeric user count, short count, hashless accounts and unreadable count.
* Failure output proven to redact: a stub seed error carrying
  `postgresql://assetflow:SuperSecret123@...` and `LOADTEST_PASSWORD=AnotherSecret456`
  prints neither secret, and keeps the raw log at mode 600.
* CI `b6d6343`: 7/7 jobs green, capacity stack 19/19 steps, including
  "Sign in as a generated fixture account through the real API" and
  checksum-verified export.
* CI `e5c1060`: 7/7 green with the shared helper in use.

## What is still unproven

The defect and its fix rest on the console evidence above, not on a successful
end-to-end run against a real t3.micro. Readiness after seeding, HTTPS edge
access from outside, fresh host metrics and a run-owned export are exercised in
CI but **not yet on EC2 with the fix in place**. That needs one fourth attempt.

## Inventory

0 run-owned instances, 0 volumes, 0 elastic IPs. SG `sg-012a0191f4e4a9a8c` has
**0 inbound rules**; the stale tcp/8443 from `47.15.100.237/32` was inspected and
removed. The group itself is intact. Production `i-0ff4690ec52d0dc01` is running.

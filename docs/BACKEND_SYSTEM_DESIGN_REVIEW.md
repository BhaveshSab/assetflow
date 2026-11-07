# Backend review — thinking like a system design engineer

Scope: the NestJS API in `backend/` on `main` @ `a7d08a5`. Every claim below points at a file and line, or at a number measured in this repository today.

---

## 0. Short answer to "are all the bugs fixed?"

**No — and no test suite can tell you that.** The acceptance run (`QA_REPORT_run2.md`, 91 checks, all four roles) proves that the *behaviours you specified* work and that *20-odd escalation attempts* are refused. It does not prove the absence of bugs, because a test only finds the bugs someone thought of.

These bug classes are still unproven in this codebase:

| Class | Why a role test cannot see it | Risk here |
|---|---|---|
| Race conditions under real concurrency | The suite calls endpoints one at a time | Code is written for it (`FOR UPDATE` locks) but **nothing tests it** — a refactor could silently delete the guarantee |
| Partial failure (write succeeds, side effect fails) | Single-process, no injected failures | Notifications/history are written after the transaction commits; a crash between them loses the notification silently |
| Scale-shaped bugs (N+1, unbounded payloads, missing indexes) | Works fine with 12 rows | Already measurable today — see §3 |
| Restart / multi-instance behaviour | One process, one replica | The reminder sweep is an in-process `setInterval` — two instances duplicate the work |
| Clock, timezone and DST edges | Only "now + N hours" is tested | Bookings are stored as UTC `DateTime`; no timezone field exists on any booking |
| Dependency outage (DB, Redis) | Not simulated | Health checks DB but not Redis; Redis is optional by design |

So: **the specified behaviour is correct; the system's guarantees under load, restart and partial failure are unverified.** That gap is exactly what a system design interview probes.

---

## 1. What this backend already does well (credit where it's due)

This is not a beginner codebase. These are the things I would *not* change:

- **The two dangerous races are handled properly with row locks**, not check-then-act:
  `SELECT id FROM "Asset" ... FOR UPDATE` in `allocations.service.ts:76`, `bookings.service.ts:93` and again in `reschedule` at `bookings.service.ts:255`. The second concurrent request waits, then sees the first one's committed row and gets the 409.
- **Strict input validation globally**: `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues` in `configure-app.ts:73-84`. Mass assignment and role injection are impossible, which the acceptance run confirmed (`property role should not exist`).
- **Rate limiting is Redis-backed with a memory fallback**, and the store in use is reported by the health endpoint (`common/rate-limit/redis-throttler.storage.ts`, `health.controller.ts:46`). Most portfolio projects never get this far.
- **Token revocation without a session table**: `credentialsChangedAt` is compared on every `validate()` (`jwt.strategy.ts:51-60`), so "logout everywhere" and password changes kill live tokens. The acceptance run proved it: change password → old session 401.
- **bcrypt with the 72-byte truncation trap documented and pre-hashed** (`common/security/password.ts`).
- **Sequential asset tags with a P2002 retry** rather than a lossy "count + 1" (`assets.service.ts:58-80`).
- **One `configureApp()` shared by the long-running server and the Vercel serverless entrypoint** (`configure-app.ts`), so the two deployments cannot drift.
- **Structured JSON logs with a request id** propagated from `x-request-id` (`common/logging/json-logger.ts`, `common/http/request-context.middleware.ts`).
- **Graceful shutdown** closes the DB pool and stops the timer (`enableShutdownHooks()`, `notifications.service.ts:58`).
- 155 e2e tests (16 suites) + 98 unit tests, and migrations that are real files, not `db push`.

---

## 2. Measured behaviour today

Measured in-process against a populated PGlite database (200 assets, 40 allocations, 30 bookings, 300 activity rows, 300 notifications). Absolute milliseconds are optimistic — this is an in-process HTTP call with no network — so read the **sizes**, and compare endpoints to each other, not to production.

| Call | Items | Payload | Rows behind it |
|---|---|---|---|
| `GET /api/assets` | 50 | **55 KB** | 200 |
| `GET /api/assets?q=Probe` | 50 | 55 KB | 200 (full `ILIKE` scan) |
| `GET /api/notifications` | 100 | 29 KB | 300 |
| `GET /api/activity` | 50 | 17 KB | 300, **no index on `createdAt`** |
| `GET /api/allocations` | 40 | 41 KB | 40 |
| `GET /api/reports/dashboard` | — | **28.5 KB**, 10 keys | whole org |
| `GET /api/reports/asset-utilization` | 298 | **42.7 KB** | grows 1 row per asset |
| `GET /api/reports/export/assets.csv` | 200 rows | 14 KB | grows 1 row per asset |

Three things to notice:

1. **`/api/assets` is ~1.1 KB per asset** — the list projection carries `category`, `currentAllocation`, `currentHolder`, `customFieldValues`, `documents`. With the 200-item cap that is a ~220 KB response. A list screen does not need `documents`.
2. **`asset-utilization` and the CSV export scale linearly with the asset table** and have no ceiling: 10,000 assets ≈ 1.4 MB of JSON in one response, inside a serverless function with a response-size limit.
3. **The dashboard sends 28.5 KB** including two embedded lists (`overdueList`, `upcomingReturnsList`) that the tables below it fetch again separately.

---

## 3. P0 — invariants the database should hold, not the code

The application enforces the two most important rules correctly. The database does not enforce them at all. That means every future code path — a script, a migration, a new endpoint, a manual `UPDATE` in the Neon SQL editor — can violate them.

**(a) One ACTIVE allocation per asset.** Today it is a `findFirst` inside a locked transaction. Add a partial unique index:

```sql
-- prisma/migrations/<timestamp>_one_active_allocation/migration.sql
CREATE UNIQUE INDEX "Allocation_one_active_per_asset"
  ON "Allocation" ("assetId")
  WHERE status = 'ACTIVE';
```

Now a second ACTIVE row is impossible at the storage layer, and the 409 becomes a database error you can translate (`P2002`) instead of a rule you must remember.

**(b) Overlapping bookings.** The overlap check is application logic (`bookings.service.ts:292-317`). Postgres can guarantee it:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_no_overlap"
  EXCLUDE USING gist (
    "assetId" WITH =,
    tstzrange("startTime", "endTime") WITH &&
  ) WHERE (status <> 'CANCELLED');
```

This is the textbook answer to "how do you prevent double-booking?" and it removes the need to trust the row lock. Note it needs a hand-written migration (Prisma cannot express `EXCLUDE`), which is itself a good thing to be able to explain.

**(c) Shape constraints that are currently only DTO rules:**

```sql
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_time_order" CHECK ("endTime" > "startTime");
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_return_after_alloc"
  CHECK ("expectedReturnDate" IS NULL OR "expectedReturnDate" >= "allocatedAt");
```

*Interview framing:* "the application validates it; the database proves it. Validation is a promise, a constraint is a guarantee."

---

## 4. P0 — prove the concurrency claims (highest value per hour)

The best part of this backend is the two `FOR UPDATE` locks, and **nothing in the 155-test suite fires two requests at once**. Two tests, ~40 lines, and the crown jewel becomes a demonstrated fact instead of a comment:

```ts
it('two concurrent allocations of the same asset: exactly one wins', async () => {
  const [a, b] = await Promise.all([
    post('/api/allocations', 'manager', { assetId, holderUserId: priya }),
    post('/api/allocations', 'manager', { assetId, holderUserId: raj }),
  ]);
  expect([a.status, b.status].sort()).toEqual([201, 409]);
  expect(await prisma.allocation.count({ where: { assetId, status: 'ACTIVE' } })).toBe(1);
});
```

Same shape for overlapping bookings (one 201, one 409, and `count(non-cancelled, overlapping) === 1`), and for the asset-tag retry (10 parallel `POST /assets` → 10 distinct tags). Run them in CI; if someone removes a lock, a test fails instead of a customer double-booking a projector.

Then raise the bar: a **load test** (`k6` or `autocannon`) on `GET /api/assets` and `POST /api/bookings`, 50 virtual users for 60 seconds, watching p95 and error rate. That gives you a real number to quote — "p95 40 ms at 50 rps on a 2 GB instance" — which is what separates a portfolio from a claim.

---

## 5. P1 — make it fast at 10× (cheap, concrete)

| Problem | Evidence | Fix | Effort |
|---|---|---|---|
| Activity feed sorts by an unindexed column | `ActivityLog` has `@@index([actorId])`, `@@index([entityType, entityId])` — no `createdAt` | `@@index([createdAt(sort: Desc)])` (Prisma supports sort order) | 15 min |
| Search is three `ILIKE '%q%'` scans per request | `assets.service.ts:135-142` | `CREATE EXTENSION pg_trgm; CREATE INDEX ... USING gin (name gin_trgm_ops)` — or Postgres FTS with a generated `tsvector` column | 1 h |
| List payload is ~1.1 KB per asset | §2 | A dedicated list projection (drop `documents`, `customFieldValues`, `currentHolder` from the list; keep them on detail) | 1 h |
| Dashboards recompute aggregates on every poll | 28.5 KB, 10 keys, whole-org scan | Cache the KPI block in Redis for 15-30 s, keyed by `(endpoint, role, departmentId)`. Invalidate on the writes that matter | 3 h |
| Reports grow with the org | `asset-utilization` 298 rows | Return `top N` + a `total`/`others` rollup; keep the full list behind `?full=true` for the CSV only | 2 h |
| Offset pagination on append-heavy tables | `skip/take` everywhere | Cursor pagination (`?after=<id>&limit=`) for `/activity` and `/notifications`; offsets stay fine for assets | 2 h |

One caution: **measure before caching.** The dashboard at 72 ms in-process is not the problem — the 28 KB payload is. Caching the KPI block fixes the second and the first.

---

## 6. P1 — reliability: the parts that only break in production

**(a) The reminder sweep is per-process.** `notifications.service.ts:49-56` runs `setInterval(..., 60_000)` on every instance. On Vercel, each warm lambda and each cold start runs its own; on two instances, two sweeps race. The existing idempotency check (`findFirst` on user+type+entity) narrows the window but is not atomic. Two honest options:

- **Cheap and correct:** wrap the sweep in a Postgres advisory lock — `SELECT pg_try_advisory_lock(42)` … `pg_advisory_unlock(42)`. One instance does the work per minute; the rest return immediately.
- **Proper:** move it to a scheduled job (Vercel Cron hitting an authenticated endpoint, or EventBridge → Lambda), i.e. a scheduler that is not the request-serving process.

**(b) Side effects are not part of the transaction.** `allocate()` commits, and only then the activity row and the notification are written (`allocations.service.ts`, post-transaction `await`s). If the process dies in between, the allocation exists and nobody was told. The standard fix is the **transactional outbox**: write the notification row inside the same transaction, and let a worker deliver it (with an attempt counter and a dead-letter state). You already have the persistence layer to do this — it is one table and one worker.

**(c) Idempotency for retried POSTs.** A mobile client that times out and retries `POST /bookings` currently gets a 409 (correct by luck, the slot is taken) — but a retried `POST /maintenance` creates two tickets. Accept an `Idempotency-Key` header, store `(key, userId, route, response)` for 24 h, replay the stored response. This is a 60-line interceptor and a very strong interview story.

**(d) Health is liveness, not readiness.** `health.controller.ts` checks the DB and reports the rate-limit store, which is good, but it does not answer "can this instance serve traffic?" (migrations applied? Redis reachable if configured?). Split into `/api/health/live` (process is up) and `/api/health/ready` (dependencies usable, migrations at head).

---

## 7. P1 — observability: you cannot debug what you cannot see

You have JSON logs with a request id. That is the baseline, not the finish line. In priority order:

1. **Error tracking** (Sentry or equivalent) on the exception filter — grouped, with stack, request id and user id. Right now a 500 in production is a line in a log stream nobody is watching.
2. **Metrics**: request count, error count and latency histogram per route (Prometheus via `@willsoto/nestjs-prometheus`, or Vercel/Datadog). Then define two SLOs: p95 latency < 300 ms, error rate < 0.5 %.
3. **Slow-query logging** — log any Prisma query above, say, 200 ms with its model and action. This is how the missing `ActivityLog.createdAt` index would have been found in a week rather than by review.
4. **Business counters**: bookings created, allocations refused with 409, reminder sweeps run, notifications unsent. A 409 spike is usually a UX problem, not a bug — you want to see it.

---

## 8. P2 — API craft (what makes it feel like a product)

- **OpenAPI spec generated from the Nest decorators** (`@nestjs/swagger`), committed, and used to generate the frontend types. Today the frontend has hand-written types that can silently drift from the DTOs. This is the single biggest maintainability win left.
- **Version the surface**: `app.setGlobalPrefix('api')` gives you `/api`, not `/api/v1`. Adding `/v1` now is free; adding it after a client ships is not.
- **One error envelope.** Today some handlers throw `ConflictException('string')` and others `ConflictException({ message, currentHolder })` (`allocations.service.ts:110-118`). Pick `{ code, message, details, requestId }` and make the filter produce it always.
- **Cache headers on read endpoints**: `ETag` + `Cache-Control: private, max-age=15` on `/reports/*` cuts repeat traffic for free; the browser stops hammering the dashboard on every tab focus.
- **`/api/v1` + pagination metadata**: every list returns `{ items, total }`; two endpoints return `{ items }`, two return arrays. Normalise.

---

## 9. P2 — security depth beyond the role gates

The role gates are solid — 403 everywhere they should be, verified. What is left is depth:

- **Refresh tokens.** A 7-day bearer token with no refresh (`auth.module.ts:32`) is a long-lived credential. Issue a 15-minute access token plus a rotating refresh token stored hashed; revocation then has two levers instead of one.
- **Per-request user lookup** (`jwt.strategy.ts:55`) is a DB round trip on every authenticated call. It buys instant revocation. Keep it, but know the cost: at 10× traffic, a 5-second in-memory cache per instance (with the `credentialsChangedAt` timestamp as the validity key) halves your database reads.
- **Secrets and rotation**: `BOOTSTRAP_ADMIN_EMAIL` must be removed after use (already on the deployment checklist), and `JWT_SECRET` rotation needs a documented procedure (two-key verification window).
- **Dependency and image scanning**: `npm audit --production` in CI as a non-blocking report, plus Dependabot.
- **Audit-log immutability**: `ActivityLog` is append-only in code; make it append-only in the database (no `UPDATE`/`DELETE` grants for the app role) if you ever split roles.

---

## 10. P2 — data lifecycle

- **Retention.** `Notification` and `ActivityLog` grow forever. Decide: notifications 90 days, activity 24 months, then a scheduled delete. Right now there is no delete path anywhere (`@Delete` appears in zero controllers), which is defensible — nothing is lost — but it is unbounded growth.
- **Backups and a restore drill.** Neon gives point-in-time recovery; a backup you have never restored is a rumour. `docs/results/restore-from-s3-*.txt` suggests a drill exists on the infra side — extend it to the database: restore to a branch, run the smoke tests against it, record the time.
- **Exports.** The CSV is built in memory and grows with the table. Stream it (`res.write` per page of 500 rows) so 10,000 assets do not become a 1.4 MB string in a lambda.

---

## 11. Capacity model — what actually changes at 10× and 100×

Guessing at scale is what makes design answers sound rehearsed. State the assumption instead:

| | Today (one institution) | 10× (a group of 10) | 100× (SaaS) |
|---|---|---|---|
| Assets / users | ~2k / ~500 | 20k / 5k | 200k / 50k |
| Peak requests | ~10-20 rps | ~200 rps | ~2k rps |
| Read/write ratio | ~10:1 | ~20:1 | ~30:1 |
| Bottleneck | none | aggregate reports, list payloads | write contention on hot assets, analytics |
| What you change | nothing — single API + Postgres is correct | Redis cache for reports, cursor pagination, partial indexes, cron for reminders | read replica for reports, materialised views, queue for notifications/email, partitioning of activity, `tenantId` on every table with row-level security |
| What you do **not** change | the schema's constraints | the API contract | the authorisation model |

The one structural thing missing for 100× is **tenancy**: every table is implicitly single-organisation. Adding `tenantId` later means touching every query at once. If this ever becomes a multi-school product, add the column and a Prisma middleware early; if it stays a single-institution tool, leave it alone and say so out loud.

---

## 12. What not to build (a design answer is also a refusal)

Do not add these to this project, and be ready to say why:

- **Kafka / RabbitMQ.** The write volume is a few hundred events a day. A Postgres-backed outbox is sufficient and keeps the failure modes visible.
- **Microservices.** The domain has four tightly coupled aggregates that share transactions (an allocation changes an asset, a booking, an audit item). Splitting them turns one ACID transaction into a saga — for no operational benefit at this size.
- **CQRS / event sourcing.** Reports are cheap aggregates over a small table. Materialised views are the honest version of "CQRS" here, and only at 100×.
- **A second database for "scale".** The bottleneck would be missing indexes, not the engine.

Saying "I deliberately did not" with a reason is a stronger signal than adding infrastructure you cannot justify.

---

## 13. Do these five things next (in this order)

1. **Concurrency tests** (§4) — 2 hours. Turns the best part of the code into a demonstrated property, and protects it.
2. **Partial unique index + booking exclusion constraint** (§3) — 2 hours including a migration and a test that the DB refuses the second row.
3. **`ActivityLog.createdAt` index + a dedicated asset list projection** (§5) — 1 hour. Immediate, measurable.
4. **OpenAPI generation wired into CI** (§8) — 3 hours. Kills an entire class of frontend/backend drift.
5. **Idempotency keys on the three creation endpoints** (§6c) — half a day. The most "senior" item on the list.

If you only do one: the concurrency test. It is the difference between "the code has locks" and "the system provably cannot double-book".

---

## 14. How to talk about this in an interview

- "Double-booking is impossible twice over: the transaction takes a row lock on the asset before the conflict check, and the database has an exclusion constraint on the time range. I have a test that fires two overlapping requests and asserts exactly one 201."
- "Allocation, booking and return all mutate two tables, so they run in one transaction with the asset row locked first — the lock ordering is always asset-then-dependent-row, which is what keeps it deadlock-free."
- "Every report is an aggregate over a small table today; I measured 42 KB for asset utilisation at 300 assets, so I cap it at top-N and move the full list behind the export. I would cache the dashboard for 30 seconds before I would consider a read replica."
- "The reminder sweep is a cron, not a request path, and it takes a Postgres advisory lock so two instances cannot both fire it. I did not add a queue for it, because one lock and one index solve the problem."
- "The honest gap: no load test yet, so I quote the design and the measured payload sizes, not a throughput number I have not verified."

The last sentence is the one that lands. Engineers who know what they have *not* proven are trusted with the things they say they have.

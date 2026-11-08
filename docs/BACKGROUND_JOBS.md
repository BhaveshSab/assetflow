# Phase 1: durable booking reminder jobs

## Scope and boundaries

Implemented: BullMQ publisher/worker, transactional outbox, durable retry budget,
revision fencing, private worker metrics/health, admin-only inspection/retry API,
opt-in Compose services and tests. This phase delivers **in-app booking
reminders**, not email reminders or asynchronous exports. Overdue allocation
reminders remain on the existing API sweeper. No frontend job console yet.

Further agreed phases, not implemented here:

1. Private S3 attachments with upload verification and authorisation.
2. Validated, previewable bulk asset import using the worker foundation.
3. QR asset lookup and authenticated audit verification.
4. OpenTelemetry tracing across API and worker, with a resource-conscious
   collector/backend choice.

Do not describe those future phases as implemented on a resume or README.

## Delivery model

- Booking creation/rescheduling saves a new `JobOutbox` row **in the same
  PostgreSQL transaction** as the business change. This happens regardless of
  whether queue mode is enabled and requires no Redis call in an HTTP request.
- Each booking has a revision. Rescheduling increments it and creates a new
  event; cancellation increments it and invalidates existing events.
- Every five seconds a separate worker backfills up to 100 future pre-feature
  bookings, claims up to 50 due events with `FOR UPDATE SKIP LOCKED`, and
  publishes immediate BullMQ jobs. The due time is thirty minutes before the
  booking. Scheduling in PostgreSQL rather than only Redis permits recovery
  after queue data loss.
- Claims expire after five minutes. A publisher crash or failed publish can
  delay a reminder until that lease expires. Multiple workers share claims.
- Jobs carry only the event ID and retry epoch. The processor locks the event
  and booking, rechecks booking revision/status/start time and recipient
  activity, then atomically commits a uniquely keyed in-app notification and
  the event's DONE state. Cancelled, stale or already-started bookings finish
  without a notification. An early job fails rather than notifying early.
- A crash before commit leaves work retryable; a crash after commit sees DONE.
  The guarantee applies to **PostgreSQL in-app notifications**, not email or
  arbitrary external effects. This is not a claim of exactly-once execution.
- Five execution attempts, with exponential queue backoff starting at one
  second. The durable budget also bounds repeated replays after Redis loss.
  Exhaustion marks FAILED. Errors stored in the database are generic categories,
  not raw Redis/database error strings that might disclose credentials.
- An ADMIN can inspect failed jobs and retry in a new epoch via `/api/jobs`.
  Old deliveries cannot consume the new epoch. Retry is audited in the same
  transaction. Only failed rows can be retried; there is no employee retry API.
- Redis completed jobs are retained up to one day/1,000 jobs; failed jobs up
  to seven days/1,000 jobs. These bounds do not remove the durable PostgreSQL
  records. Outbox rows currently have no automatic retention cleanup: monitor
  growth and do not delete active/failed rows manually.

Concurrent cancellation is ordered by the booking row lock: a cancellation
committed before processing suppresses the reminder. Cancelling after a reminder
was committed does not retract that historical notification.

## Configuration and rollout (approval required)

This change does **not** enable queues in an existing deployment. Review memory
and disk capacity first: the worker and dedicated Redis each have a 256 MB
container ceiling, on top of the existing stack. Do not overload a small host.

- `JOBS_ENABLED=false` (default): existing booking/overdue sweepers remain.
- `JOBS_ENABLED=true`: API booking sweeper is disabled; worker owns booking
  reminders. The overdue sweeper remains. There is intentionally no silent
  booking fallback during Redis outages, because it could duplicate delivery.
- `JOBS_REDIS_URL`: worker-only `redis://` or `rediss://` URL, with URL-encoded
  credentials when necessary. Never point it at the rate-limit Redis.
- `JOBS_METRICS_PORT`: worker HTTP port, default 4001. Keep it private.
- Compose uses `JOBS_REDIS_PASSWORD` to build the worker URL. Use a long
  URL-safe random password stored only in `infra/.env`. Starting the jobs Redis
  without a password fails rather than exposing an unauthenticated service.

The `jobs` Compose profile supplies a **separate** Redis with AOF, a persistent
volume and `noeviction`. The existing rate-limit Redis has `allkeys-lru` and is
not suitable for a durable queue. AOF every second may lose recent Redis writes
on a host crash; uncompleted outbox rows are replayed after the lease expires.
This does not protect against losing the PostgreSQL database itself.

After approved rollout: apply the migration, set the flag consistently on the
API and worker, and start profile `jobs` using the API image built from the same
commit. `deploy.sh` reconciles/waits for those services when the flag is true,
and stops an old worker when the flag is false. Worker failure after API
readiness fails deployment visibly; it does not roll back a healthy API.

For a local/Codespace environment with its own database and dedicated Redis:

```sh
cd backend
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
# Set DATABASE_URL, JOBS_ENABLED=true and JOBS_REDIS_URL in the worker
# environment before this command (do not paste secrets into GitHub issues).
npm run start:worker
```

The worker is a long-lived process. Vercel API imports never start BullMQ,
connections, publisher timers or a worker. Vercel deployments that enable queue
mode still need a separately hosted worker reaching the same PostgreSQL DB.

## Operations

The private worker exposes `/health` (503 until a successful publisher tick,
then 503 if no successful tick in thirty seconds) and `/metrics`:

- `assetflow_jobs_outbox{state}` — durable state counts.
- `assetflow_jobs_queue{state}` — queue counts.
- `assetflow_jobs_oldest_due_seconds` — oldest unfinished due event, including
  failed events.

Metrics retain their last collected values during a dependency outage; always
check `/health` too. The optional Prometheus file
`infra/prometheus/targets/jobs.yml` is empty by default. On approved rollout,
set it to `[{targets: ["worker:4001"]}]`; keep it empty when jobs are disabled.
No new production alert delivery is claimed from exposing these metrics alone.

## Reproduce tests

```sh
cd backend
npm run test:unit
npm run test:e2e -- --runInBand jobs.e2e-spec.ts
# Explicitly use an isolated disposable Redis, NEVER production:
TEST_JOBS_REDIS_URL=redis://localhost:16379 npm run test:e2e -- --runInBand jobs-queue.e2e-spec.ts
```

CI supplies a disposable Redis and runs the queue integration suite automatically.
Without `TEST_JOBS_REDIS_URL`, that integration suite is explicitly skipped;
the database/API reminder suite still runs. Every integration test uses a unique
queue name and deletes only its own queue, not an entire Redis database.

See [local Phase 1 results](results/background-jobs-phase1.md) for executed
commands and results. Production enablement and multi-machine failure drills
remain unverified until an approved rollout.

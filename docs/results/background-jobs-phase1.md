# Background jobs — Phase 1 local verification

Environment: sandbox Node.js, Prisma PostgreSQL adapter, PGlite replaying all
nine repository migrations, and an isolated Redis 7.4.2 built from upstream
source. Redis was bound to loopback on port 16379 with `noeviction`; these tests
never reached the production database/Redis. The disposable Redis intentionally
had no persistence; production Compose configuration separately enables AOF.

| Command (from backend) | Observed result |
|---|---|
| `npm run lint -- --no-fix` | 0 errors, 0 warnings |
| `npm run build` | Passed, including `dist/worker.js` |
| `npm run test:unit` | 15 suites, 101 tests passed |
| `TEST_JOBS_REDIS_URL=redis://127.0.0.1:16379 npm run test:e2e -- --runInBand` | 19 suites passed; 178 tests passed, 1 skipped |

New coverage: 12 reminder/outbox/API tests, four real BullMQ integration tests,
and three queue-configuration unit tests. Queue integration exercises real
publication/processing, health/metrics, recovery from a missing queue plus an
expired publisher lease, existing-booking backfill, five failed attempts and
admin retry recovery in a new epoch. A malformed topic is injected only into
this disposable test database to exercise the failure path.

The database tests cover atomic rollback, overlap rejection, concurrent duplicate
delivery, cancellation, rescheduling, early delivery, downtime/expired bookings,
inactive recipients, role enforcement, audit logging and durable attempt limits.

Limits: not a Redis process-kill/persistence durability drill, not a multi-host
throughput benchmark, not a production notification test. No emails are sent.
The test's one skipped case is reported as skipped, not passed. The default e2e
harness uses forceExit; a separate no-forceExit queue run is useful when
investigating lifecycle leaks. This file is a local result record; PR CI results
are linked on the pull request separately.

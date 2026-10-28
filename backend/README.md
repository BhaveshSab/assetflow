# AssetFlow API

The NestJS 11 + Prisma 6 backend that powers the AssetFlow SPA.
It exposes every resource under **`/api`**, validates every payload with
`class-validator`, and authenticates with stateless JWTs.

> 📖 The complete endpoint contract (parameters, status codes, role rules)
> lives in [`API.md`](./API.md). The project overview, the full environment
> matrix and the deployment guide live in the [root README](../README.md).

---

## 🚀 Getting started

```bash
cd backend
npm install
cp .env.example .env          # edit DATABASE_URL + JWT_SECRET
npm run prisma:migrate        # apply the schema (uses DATABASE_URL_UNPOOLED when set)
npm run seed                  # optional demo data (5 accounts, password123)
npm run start:dev             # http://localhost:4000/api
```

Health check:

```bash
curl http://localhost:4000/api          # → Hello World!
curl http://localhost:4000/api/health   # → { "status": "ok", "database": "up", "timestamp": "…" }
```

---

## ⚙️ Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `DATABASE_URL` | — | **required** — `postgresql://user:pass@host:5432/db` — the driver is chosen automatically (see [Database & Prisma](#️-database--prisma)) |
| `DATABASE_URL_UNPOOLED` | — | optional — direct (unpooled) URL used for **migrations only**; `npm run prisma:migrate` prefers it |
| `JWT_SECRET` | `dev-secret` (dev) | **required in production** — ≥ 32 chars |
| `JWT_EXPIRES_IN` | `7d` | token lifetime (`15m`, `24h`, `7d`, …) |
| `BCRYPT_ROUNDS` | `12` | bcrypt cost factor (4 = fastest, 15 = slowest) |
| `PORT` | `4000` | HTTP port |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:5174` | comma-separated origin allow-list |
| `THROTTLE_TTL` | `60000` | global limiter window (ms) |
| `THROTTLE_LIMIT` | `300` | global limiter requests / IP / window |
| `AUTH_THROTTLE_TTL` | `900000` | sign-in limiter window (ms) |
| `AUTH_THROTTLE_LIMIT` | `10` | failed sign-ins before the account is blocked |
| `REDIS_URL` | — | optional — `redis://[:password@]host:6379`; when set, the rate-limit counters are **shared** by every instance and survive a restart |
| `METRICS_ENABLED` | `false` | exposes `GET /api/metrics` (Prometheus) — keep it off on a public deployment |

The environment is validated by [`src/config/env.validation.ts`](./src/config/env.validation.ts)
at boot. A missing `DATABASE_URL` or a placeholder `JWT_SECRET` in production
**does not crash the deployment**: the API still starts, but every route
answers with a `503` that names the offending variable and `GET /api/health`
reports `status: "degraded"` with the same reason. The local dev server
(`main.ts`) still refuses to start — there you want the loud failure.

| Layer | What happens on an invalid environment |
|-------|-----------------------------------------|
| `main.ts` (local dev) | the process exits with the validation message |
| `serverless.ts` (Vercel) | the function boots, every route returns `503` + reason, `/api/health` stays public |

---

## 🗄 Database & Prisma

* `prisma/schema.prisma` is the single source of truth (11 models).
* `prisma/migrations/**` contains plain SQL, replayed by `prisma migrate deploy`.
* The client is generated with **`engineType = "client"`** (Rust-free), so it
  always runs through a **driver adapter**:

  | `DATABASE_URL` host | Adapter | Notes |
  |---------------------|---------|-------|
  | `*.neon.tech` (direct) | `@prisma/adapter-neon` | WebSocket tunnel on port 443 — works where raw TCP is blocked |
  | `*-pooler.*` (pooled) | `@prisma/adapter-pg` | PgBouncer speaks plain Postgres — **no** WebSocket protocol |
  | anything else | `@prisma/adapter-pg` | local Docker Postgres, RDS, Supabase, … |

  The factory lives in [`src/prisma/prisma.service.ts`](./src/prisma/prisma.service.ts)
  and is reused by `prisma/seed.ts`, so the seed and the API always connect the
  same way. If the adapter cannot be created the service logs the reason and
  falls back to a stub instead of taking the whole process down.

> **Neon pooled vs. direct:** use the **pooled** URL (`…-pooler.…`) for
> `DATABASE_URL` and the **direct** URL for `DATABASE_URL_UNPOOLED` — Prisma's
> migration engine cannot run through PgBouncer.

```bash
npm run prisma:generate   # regenerate the typed client
npm run prisma:migrate    # apply migrations (prefers DATABASE_URL_UNPOOLED)
npm run seed              # idempotent demo data
```

---

## 🧪 Tests

```bash
npm run test:unit    # 55 checks — no database needed
npm run test:e2e     # 111 checks — real Postgres (embedded), full HTTP stack
npm run test:all     # both
npm run lint         # ESLint + Prettier (src/ and test/)
npm run build        # tsc → dist/
```

The e2e suites boot the **real** Nest application against a real PostgreSQL
server: [`test/global-setup.ts`](./test/global-setup.ts) starts a
[PGlite](https://pglite.dev) socket server on `127.0.0.1:54329`, replays every
migration and injects a test environment. No Docker, no cloud database.

| Suite | Covers |
|-------|--------|
| `auth.e2e-spec.ts` | sign-up/sign-in, RBAC, deactivation, throttling |
| `assets.e2e-spec.ts` | asset tags, filters, status rules, history |
| `allocations.e2e-spec.ts` | allocate/return/transfer, conflicts, department scoping |
| `bookings.e2e-spec.ts` | overlap detection, cancellation, re-scheduling |
| `maintenance.e2e-spec.ts` | the full workflow, invalid jumps, asset state |
| `audits.e2e-spec.ts` | cycles, auditors, items, discrepancies |
| `reports.e2e-spec.ts` | KPIs, charts, CSV export (incl. formula-injection guard) |
| `org.e2e-spec.ts` | departments, categories, employees, roles |
| `notifications.e2e-spec.ts` | inbox, read state, pings |
| `scoping.e2e-spec.ts` | row-level scoping + asset/allocation consistency |
| `app.e2e-spec.ts` | health route, security headers, 404 shape |
| `health.e2e-spec.ts` | public `GET /api/health` + `/api/health/ready`, 503 on an invalid environment |
| `observability.e2e-spec.ts` | the request id, the structured logs, the Prometheus endpoint |

---

## 🗂 Layout

```
backend/
├── api/index.js            # Vercel serverless entry point
├── prisma/
│   ├── schema.prisma       # data model
│   ├── migrations/         # SQL migrations
│   └── seed.ts             # demo data
├── scripts/migrate.js      # migration runner (honours DATABASE_URL_UNPOOLED)
├── src/
│   ├── common/             # decorators, guards, security helpers, scopes
│   ├── config/             # environment validation + startup status
│   ├── health/             # public GET /api/health
│   ├── prisma/             # driver-adapter aware PrismaService
│   ├── auth/               # sign-up, sign-in, JWT strategy, throttle
│   ├── assets/ allocations/ bookings/ maintenance/ audits/
│   ├── org/ reports/ notifications/ activity/
│   ├── app.module.ts       # root module (env validation, throttler)
│   ├── configure-app.ts    # helmet, CORS, validation pipe, shutdown hooks
│   ├── main.ts             # local/dev server
│   └── serverless.ts       # Vercel entry point
└── test/                   # Jest e2e suites + embedded Postgres
```

---

## 🩺 Deployment troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `500 FUNCTION_INVOCATION_FAILED` | the function crashed while booting | the API now returns a readable JSON error — check the Vercel runtime logs and `/api/health` |
| `503` on every route | the environment is invalid | the message names the variable (`startupError`) — fix it and redeploy |
| `relation "User" does not exist` | migrations were never applied | `npm run prisma:migrate` with `DATABASE_URL_UNPOOLED` pointing at the same database |
| Neon WebSocket handshake fails | a pooled URL was used with the WebSocket driver | use the direct `*.neon.tech` URL, or keep the pooled URL — the driver is now chosen automatically |
| `CORS` errors in the browser | `CORS_ORIGINS` misses the frontend origin | add it (no trailing slash) and redeploy |
| `Query Engine could not be located` | the Prisma client was not generated | `npm run prisma:generate` — Vercel does this in `npm run vercel-build` |

---

## 📈 Observability & the shared rate limiter

| Piece | What it does |
|-------|--------------|
| `GET /api/metrics` | the Prometheus endpoint — request counter, duration histogram, the state of the shared store. Disabled unless `METRICS_ENABLED=true` |
| `RequestContextMiddleware` | gives every request an id (`x-request-id`, taken from the incoming header when there is one), measures it and writes **one JSON object per line** to the log |
| `JsonLogger` | the same format for the logs of Nest itself |
| `RedisThrottlerStorage` | keeps the rate-limit counters in Redis, so the limit is **global** instead of per process |
| `RedisLoginAttemptStore` | keeps the failed-sign-in counters in Redis — without it a restart (or a new serverless instance) resets the brute-force protection |

Both stores **fail open to the in-process counter** when Redis is
unreachable: the API keeps serving, and the degradation is reported through
`GET /api/health` (`redis: "down"`) and the
`assetflow_throttle_store_degraded` metric.

The self-hosted deployment of all of this lives in [`../infra`](../infra) and
is documented in [`../docs`](../docs).

---

## 🔒 Security notes

* Passwords are bcrypt-hashed over a **SHA-512 pre-hash**, so passwords longer
  than bcrypt's 72-byte limit stay distinct.
* Unknown e-mail and wrong password produce the **same** error *and* the same
  amount of bcrypt work (timing equalisation).
* E-mails are normalised (trimmed + lower-cased) and matched case-insensitively.
* The JWT strategy **re-reads the user on every request**, so deactivating an
  account or changing a role takes effect immediately.
* Sign-in is throttled per account **and** per IP; every route additionally
  has a global per-IP limiter.
* `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` rejects
  unknown body fields and strips everything that is not declared.
* Role changes and deactivations of the **last active admin** are refused.
* Row-level scoping lives in [`src/common/auth/scopes.ts`](./src/common/auth/scopes.ts)
  and is applied by the allocations, maintenance, bookings and reports services.

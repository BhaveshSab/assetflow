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
npx prisma migrate deploy     # apply the schema
npm run seed                  # optional demo data (5 accounts, password123)
npm run start:dev             # http://localhost:4000/api
```

Health check: `curl http://localhost:4000/api` → `Hello World!`

---

## ⚙️ Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `DATABASE_URL` | — | **required** — `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | `dev-secret` (dev) | **required in production** — ≥ 32 chars |
| `JWT_EXPIRES_IN` | `7d` | token lifetime (`15m`, `24h`, `7d`, …) |
| `BCRYPT_ROUNDS` | `12` | bcrypt cost factor (4 = fastest, 15 = slowest) |
| `PORT` | `4000` | HTTP port |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:5174` | comma-separated origin allow-list |
| `THROTTLE_TTL` | `60000` | global limiter window (ms) |
| `THROTTLE_LIMIT` | `300` | global limiter requests / IP / window |
| `AUTH_THROTTLE_TTL` | `900000` | sign-in limiter window (ms) |
| `AUTH_THROTTLE_LIMIT` | `10` | failed sign-ins before the account is blocked |

The environment is validated by [`src/config/env.validation.ts`](./src/config/env.validation.ts)
at boot — a missing `DATABASE_URL` or a placeholder `JWT_SECRET` in production
stops the process with an actionable message instead of failing later.

---

## 🗄 Database & Prisma

* `prisma/schema.prisma` is the single source of truth (11 models).
* `prisma/migrations/**` contains plain SQL, replayed by `prisma migrate deploy`.
* The client is generated with **`engineType = "client"`** (Rust-free), so it
  always runs through a **driver adapter**:

  | `DATABASE_URL` host | Adapter |
  |---------------------|---------|
  | `*.neon.tech` | `@prisma/adapter-neon` (WebSocket tunnel, port 443) |
  | anything else | `@prisma/adapter-pg` (`pg`) |

  The factory lives in [`src/prisma/prisma.service.ts`](./src/prisma/prisma.service.ts)
  and is reused by `prisma/seed.ts`, so the seed and the API always connect the
  same way.

```bash
npm run prisma:generate   # regenerate the typed client
npx prisma migrate deploy # apply migrations
npm run seed              # idempotent demo data
```

---

## 🧪 Tests

```bash
npm run test:unit    # 26 checks — no database needed
npm run test:e2e     # 102 checks — real Postgres (embedded), full HTTP stack
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

---

## 🗂 Layout

```
backend/
├── api/index.js            # Vercel serverless entry point
├── prisma/
│   ├── schema.prisma       # data model
│   ├── migrations/         # SQL migrations
│   └── seed.ts             # demo data
├── src/
│   ├── common/             # decorators, guards, security helpers, scopes
│   ├── config/             # environment validation
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

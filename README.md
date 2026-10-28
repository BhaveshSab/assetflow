<div align="center">

# 🧾 AssetFlow

**Enterprise Asset & Resource Management System**

Track, allocate, book, maintain and audit every physical asset and shared
resource an organisation owns — from one laptop to a thousand.

[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square&logo=nestjs&logoColor=white)](https://nestjs.com)
[![Prisma](https://img.shields.io/badge/Prisma-6-2D3748?style=flat-square&logo=prisma&logoColor=white)](https://www.prisma.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Tailwind](https://img.shields.io/badge/Tailwind-3-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![License](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)](#license)

</div>

---

## 📑 Table of contents

- [What AssetFlow does](#-what-assetflow-does)
- [Feature map](#-feature-map)
- [Architecture](#-architecture)
- [Quick start](#-quick-start)
- [Environment variables — every parameter](#-environment-variables--every-parameter)
- [Roles & permissions](#-roles--permissions)
- [API overview](#-api-overview)
- [Testing](#-testing)
- [Security model](#-security-model)
- [Deploying to Vercel](#-deploying-to-vercel)
- [Self-hosted infrastructure](#-self-hosted-infrastructure)
- [Project layout](#-project-layout)
- [Troubleshooting](#-troubleshooting)

---

## 💡 What AssetFlow does

AssetFlow is a full ERP module for **physical assets and shared resources**.
It covers the complete lifecycle:

```
   Register  ──▶  Allocate  ──▶  Use  ──▶  Return  ──▶  Maintain  ──▶  Audit
      ▲             │           │         │           │            │
      │             └── Transfer workflow ──────────┘            │
      └──────────────────────── Bookable resources ───────────────┘
```

| # | Module | What you get |
|---|--------|--------------|
| 1 | **Authentication** | Sign-up (always an Employee), email/password sign-in, **Sign in with Google** (verified ID token, account linking), JWT sessions, deactivation-aware guards |
| 2 | **Dashboards** | Role-specific KPI dashboards (Admin / Manager / Employee) with live charts |
| 3 | **Organisation setup** | Departments (with hierarchy + head), asset categories (with custom fields), employee directory |
| 4 | **Asset directory** | Auto-tagged assets (`AF-0001`), search, filters, full history per asset |
| 5 | **Allocation & transfer** | Allocate to a person *or* a department, conflict-safe, approval-based transfers |
| 6 | **Resource booking** | Time-slot reservations of bookable assets with overlap protection |
| 7 | **Maintenance** | `PENDING → APPROVED → TECHNICIAN_ASSIGNED → IN_PROGRESS → RESOLVED` workflow |
| 8 | **Asset audits** | Scoped audit cycles, auditor assignment, discrepancy reports, automatic LOST/DAMAGED flags |
| 9 | **Reports & analytics** | Utilisation, status distribution, maintenance frequency, booking heat-map, CSV export |
| 10 | **Notifications & activity log** | In-app notifications plus an immutable “who did what, when” trail |

---

## ✨ Feature map

| Feature | Frontend screen | API endpoints |
|---------|-----------------|---------------|
| Dashboard | `Dashboard` | `GET /api/reports/dashboard`, `/api/reports/dashboard/employee/*` |
| Asset directory | `AssetDirectory` | `GET/POST/PATCH /api/assets`, `GET /api/assets/:id/history` |
| Allocations & transfers | `AllocationsTransfers` | `POST /api/allocations`, `/api/allocations/:id/return`, `/api/transfers*` |
| Resource booking | `ResourceBooking` | `GET/POST /api/bookings`, `/api/bookings/:id/cancel|reschedule` |
| Maintenance | `Maintenance` | `GET/POST /api/maintenance`, `/api/maintenance/:id/{approve,reject,assign,start,resolve}` |
| Asset audits | `AssetAudits` | `GET/POST /api/audits`, `/api/audits/:id/{items,auditors,close,discrepancies}` |
| Reports & analytics | `ReportsAnalytics` | `GET /api/reports/*`, `GET /api/reports/export/assets.csv` |
| Organisation setup | `OrganizationSetup` | `/api/org/departments`, `/api/org/categories`, `/api/org/employees` |
| Notifications | `NotificationBell` | `GET /api/notifications`, `/api/notifications/:id/read`, `/read-all`, `/ping` |
| Activity log | `ActivityLogs` | `GET /api/activity` |

The full, line-by-line contract lives in [`backend/API.md`](backend/API.md).

---

## 🏗 Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  React 18 + TypeScript + Vite + Tailwind + shadcn/ui + Recharts      │
│  (SPA — role-aware dashboard, live data via fetch + JWT)             │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  HTTPS · Authorization: Bearer <jwt>
┌───────────────────────────────▼──────────────────────────────────────┐
│  NestJS 11  ·  /api  ·  global ValidationPipe · helmet · throttler   │
│  ┌────────┬──────────┬───────────┬──────────┬──────────┬──────────┐  │
│  │  Auth  │   Org    │  Assets   │Allocation│ Booking  │Maintenan.│  │
│  ├────────┴──────────┴───────────┴──────────┴──────────┴──────────┤  │
│  │  Audits  ·  Reports  ·  Notifications  ·  ActivityLog          │  │
│  └──────────────────────────┬──────────────────────────────────────┘  │
└─────────────────────────────┼─────────────────────────────────────────┘
                              │  Prisma 6 (Rust-free client)
        ┌─────────────────────┴─────────────────────┐
        │  @prisma/adapter-neon  ·  @prisma/adapter-pg│
        └─────────────────────┬─────────────────────┘
                    ┌─────────▼─────────┐
                    │   PostgreSQL      │
                    └───────────────────┘
```

**Why a Rust-free Prisma client?** `schema.prisma` uses `engineType = "client"`,
so the API talks to Postgres through a **driver adapter** instead of loading a
platform-specific native binary. Same code path on a laptop, on Docker and on
Vercel serverless — no `binaryTargets` to keep in sync, smaller bundles, faster
cold starts.

| Layer | Choice |
|-------|--------|
| Frontend | React 18, TypeScript, Vite 5, Tailwind 3, shadcn/ui, Recharts, Framer Motion, lucide-react |
| Backend | NestJS 11, TypeScript, class-validator, passport-jwt, bcrypt 6, helmet, @nestjs/throttler |
| Data | PostgreSQL 14+, Prisma 6, Neon (serverless) **or** any Postgres via `pg` |
| Tests | Jest + Supertest (backend, real embedded Postgres), Vitest (frontend) |

---

## 🚀 Quick start

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 22.x |
| npm | 10+ |
| PostgreSQL | 14+ (or a free [Neon](https://neon.tech) database) |

### 1️⃣ Backend (API)

```bash
cd backend
npm install

cp .env.example .env          # then edit DATABASE_URL / JWT_SECRET
npm run prisma:migrate        # create the schema (uses DATABASE_URL_UNPOOLED when set)
npm run seed                  # optional demo data

npm run start:dev             # http://localhost:4000/api
```

<details>
<summary>🐳 No Postgres installed? Start one with Docker</summary>

```bash
docker run -d --name assetflow-db \
  -e POSTGRES_USER=assetflow -e POSTGRES_PASSWORD=assetflow -e POSTGRES_DB=assetflow \
  -p 5433:5432 postgres:16-alpine

# …then set in backend/.env:
# DATABASE_URL="postgresql://assetflow:assetflow@localhost:5433/assetflow"
```
</details>

### 2️⃣ Frontend (SPA)

```bash
npm install                   # in the repository root
cp .env.example .env.local    # optional — the default points at localhost:4000
npm run dev                   # http://localhost:5173
```

### 3️⃣ Sign in

```bash
npm run seed                  # creates these accounts (password: password123)
```

| Email | Role | Sees |
|-------|------|------|
| `admin@assetflow.com` | **Admin** | Organisation setup, every report, the full activity log |
| `manager@assetflow.com` | **Asset Manager** | Register/allocate assets, approve transfers, triage maintenance |
| `head@assetflow.com` | **Department Head** | Department-scoped allocations, transfers and approvals |
| `priya@acme.com` / `raj@acme.com` | **Employee** | My assets, bookings, maintenance requests |

> The SPA talks to the **real** API — a wrong password (or an account that has
> been deactivated) is rejected, there is no offline demo mode.

### 4️⃣ Sign in with Google (optional)

Google is **off by default** and turns on the moment a client id is present.
No client secret is stored anywhere: the browser receives a signed ID token
from Google Identity Services and the API verifies it against Google's public
keys ([`auth.service.ts`](backend/src/auth/auth.service.ts)).

1. Google Cloud Console → **APIs & Services → Credentials** → **Create OAuth
   client ID** → **Web application**.
2. Add the origins that will show the button, for example:
   `http://localhost:5173`, `https://your-frontend.vercel.app`,
   `https://3.107.83.86.sslip.io`. There is **no redirect URI** to add — the
   ID-token flow opens a popup and returns the token to the page.
3. Put the client id (it ends in `.apps.googleusercontent.com`) in
   `backend/.env` or `infra/.env`:

   ```bash
   GOOGLE_CLIENT_ID="1234567890-abc.apps.googleusercontent.com"
   ```

4. Restart the API (or `docker compose up -d api`). The sign-in page reads
   `GET /api/auth/config`; if the id is missing, the Google button is disabled
   instead of failing on click.

A first Google sign-in creates an **EMPLOYEE** (the same role a normal signup
gets). When the verified Google email already belongs to a password account,
the Google identity is linked to it — the person keeps their existing role,
assets and bookings.

---

## 🔐 Environment variables — every parameter

### Frontend (`/.env.local` or your host's project settings)

| Variable | Type | Default | Required | Description |
|----------|------|---------|:--------:|-------------|
| `VITE_API_BASE_URL` | string | `http://localhost:4000/api` | no | Base URL of the API **including** the `/api` prefix. Inlined at build time — changing it needs a rebuild. |

> The Google client id is **not** a frontend build variable: the SPA reads it
> from `GET /api/auth/config` at runtime, so rotating it does not need a
> frontend rebuild.

### Backend (`/backend/.env`)

All backend variables are **validated at boot**
(`backend/src/config/env.validation.ts`). A missing or malformed value does
**not** crash the deployment any more: the API boots anyway and answers with a
`503` that names the offending variable, while `GET /api/health` reports it as
`status: "degraded"`.

| Variable | Type | Default | Required | Description |
|----------|------|---------|:--------:|-------------|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` | no | Runtime mode. In `production` the JWT secret rules below are enforced. |
| `DATABASE_URL` | string | — | **yes** | PostgreSQL connection string, e.g. `postgresql://user:pass@host:5432/db`. The driver is picked automatically: a **direct** `*.neon.tech` host uses the Neon WebSocket adapter, a **pooled** `*-pooler.*` host and every other host use `pg` over TCP. |
| `DATABASE_URL_UNPOOLED` | string | — | no | Direct (unpooled) URL used **for migrations only** — Prisma needs a direct connection, PgBouncer (Neon's pooled endpoint) does not support it. `npm run prisma:migrate` picks it up automatically. |
| `JWT_SECRET` | string | `dev-secret` (dev only) | **yes in production** | Secret used to sign access tokens. Must be **≥ 32 characters** and unique in production. Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. |
| `JWT_EXPIRES_IN` | string | `7d` | no | Token lifetime — `15m`, `24h`, `7d`, … |
| `GOOGLE_CLIENT_ID` | string | — | no | Public OAuth **client id** of a Google "Web application". Enables `/auth/google` and the button on the sign-in page. No client secret is used. |
| `BCRYPT_ROUNDS` | number | `12` | no | Password hashing cost. 4 = fastest (tests), 12 = secure default, 15 = slowest. |
| `PORT` | number | `4000` | no | Port the API listens on. |
| `CORS_ORIGINS` | string | `http://localhost:5173,http://localhost:5174` | no | Comma-separated list of allowed browser origins (no trailing slash). |
| `THROTTLE_TTL` | number (ms) | `60000` | no | Window of the global per-IP rate limiter. |
| `THROTTLE_LIMIT` | number | `300` | no | Requests per IP per window across **all** routes. |
| `AUTH_THROTTLE_TTL` | number (ms) | `900000` | no | Window of the sign-in brute-force limiter. |
| `AUTH_THROTTLE_LIMIT` | number | `10` | no | Failed sign-ins per account+IP before the account is blocked. |
| `REDIS_URL` | string | — | no | `redis://[:password@]host:6379` — when it is set, the rate-limit counters (and the failed-sign-in counters) are **shared** by every instance and survive a restart. Without it they live in the process. |
| `METRICS_ENABLED` | boolean | `false` | no | Exposes `GET /api/metrics` (the Prometheus endpoint). Keep it off on a public deployment — the self-hosted stack turns it on and lets only the internal Nginx reach it. |

<details>
<summary>🔎 Ports at a glance</summary>

| Port | Used by |
|------|---------|
| `5173` / `5174` | Vite dev server (frontend) |
| `4000` | AssetFlow API (`http://localhost:4000/api`) |
| `5433` | Local PostgreSQL in Docker (the sample `DATABASE_URL`) |
| `54329` | Embedded Postgres used by the automated test-suite |
</details>

---

## 👥 Roles & permissions

| Capability | Admin | Asset Manager | Dept. Head | Employee |
|---|:---:|:---:|:---:|:---:|
| Organisation setup (departments, categories, roles) | ✅ | | | |
| Register / edit / retire assets | ✅ | ✅ | | |
| Allocate assets | ✅ | ✅ | | |
| Return an asset | ✅ | ✅ | own department | own assets |
| Approve transfers | ✅ | ✅ | own department | |
| Raise maintenance | ✅ | ✅ | ✅ | ✅ |
| Approve / assign / resolve maintenance | ✅ | ✅ | | |
| Create & close audit cycles | ✅ | | | |
| Audit as an assigned auditor | ✅ | ✅ | ✅ (when assigned) | |
| Book resources | ✅ | ✅ | ✅ | ✅ |
| View org-wide analytics & CSV export | ✅ | ✅ | | |
| Organisation-wide activity log | ✅ | ✅ | | |
| Manage the employee directory & roles | ✅ | | | |

Roles are **only** assignable by an Admin (`PATCH /api/org/employees/:id/role`).
Signing up always creates an Employee, and the API refuses to demote or
deactivate the last remaining active Admin.

---

## 🔌 API overview

Base URL: `http://localhost:4000/api` · every response is JSON · list endpoints
return `{ items, total }`.

```bash
# Health check (public) — tells you whether the config and the database are OK
curl http://localhost:4000/api/health
# → { "status": "ok", "database": "up", "timestamp": "…" }

# Sign in
curl -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@assetflow.com","password":"password123"}'

# Use the token
curl http://localhost:4000/api/assets \
  -H 'Authorization: Bearer <token>'
```

<details>
<summary>📚 All 60+ endpoints (grouped)</summary>

**Health** — `GET /health` (public) — `status` (`ok` / `degraded`), `database` (`up` / `down`), `rateLimitStore` (`redis` / `memory`) · `GET /health/ready` — the readiness probe (200 / 503)

**Auth** — `POST /auth/signup` · `POST /auth/login` · `GET /auth/config` (Google availability) · `POST /auth/google` (ID-token exchange) · `GET /auth/me`

**Organisation** — `POST|GET /org/departments` · `GET|PATCH /org/departments/:id` ·
`POST|GET /org/categories` · `GET|PATCH /org/categories/:id` ·
`GET|POST /org/employees` · `GET /org/employees/directory` ·
`GET|PATCH /org/employees/:id` · `PATCH /org/employees/:id/role`

**Assets** — `POST|GET /assets` · `GET|PATCH /assets/:id` · `GET /assets/:id/history`

**Allocations & transfers** — `POST /allocations` · `GET /allocations` ·
`GET /allocations/my` · `GET /allocations/overdue` · `POST /allocations/:id/return` ·
`POST /transfers` · `GET /transfers` · `POST /transfers/:id/approve` · `POST /transfers/:id/reject`

**Bookings** — `POST|GET /bookings` · `GET /bookings/my` · `GET /bookings/:id` ·
`POST /bookings/:id/cancel` · `PATCH /bookings/:id/reschedule`

**Maintenance** — `POST|GET /maintenance` · `GET /maintenance/my` · `GET /maintenance/:id` ·
`POST /maintenance/:id/{approve,reject,assign,start,resolve}`

**Audits** — `POST|GET /audits` · `GET /audits/:id` · `GET /audits/:id/items` ·
`POST /audits/:id/auditors` · `PATCH /audits/:id/items/:itemId` ·
`GET /audits/:id/discrepancies` · `POST /audits/:id/close`

**Reports** — `GET /reports/dashboard` · `/reports/dashboard/employee/{kpis,activity,chart}` ·
`/reports/{asset-activity,asset-status,analytics,asset-utilization,maintenance-frequency,due-maintenance,department-allocation,booking-heatmap}` ·
`GET /reports/export/assets.csv`

**Notifications & activity** — `GET /notifications` · `PATCH /notifications/:id/read` ·
`POST /notifications/read-all` · `POST /notifications/ping` · `GET /activity`

</details>

The authoritative contract — parameters, status codes and role rules — is in
[`backend/API.md`](backend/API.md).

---

## 🧪 Testing

The project ships with **202 automated checks** that run against a **real
PostgreSQL** (embedded via [PGlite](https://pglite.dev), Postgres compiled to
WebAssembly) — no Docker, no cloud database, no network required.

```bash
# Backend — unit tests (fast, no database)
cd backend
npm run test:unit

# Backend — end-to-end tests (boots Postgres + the whole Nest app)
npm run test:e2e

# …or both
npm run test:all

# Frontend — Vitest
cd ..
npm test
```

| Suite | Command | What it covers |
|-------|---------|----------------|
| Backend unit | `cd backend && npm run test:unit` | **62 checks** — password hashing (incl. the 72-byte bcrypt truncation), environment validation, brute-force throttle, auth service, Google ID-token verification/linking, database-driver selection, the Redis-backed rate limiter |
| Backend e2e | `cd backend && npm run test:e2e` | **114 checks** — auth & RBAC, Google availability, assets, allocations & transfers, bookings, maintenance, audits, reports, org setup, notifications, row-level scoping, health, observability |
| Frontend | `npm test` | **26 checks** — API client, session handling, Google config/exchange, avatar initials |
| Lint | `cd backend && npm run lint` | ESLint + Prettier over `src/` **and** `test/` — must be clean |

What the e2e suite proves, among other things:

- an employee **cannot** create assets, read analytics or approve maintenance
- an asset can only be allocated **once** — the second attempt returns `409`
- a department head can only return/transfer **their own department's** assets
- booking the same slot twice returns `409`, touching slots are allowed
- invalid workflow jumps (`PENDING → RESOLVED`) return `409`
- a deactivated account cannot sign in, and an existing token stops working
- brute-forcing a password is throttled with `429`
- the CSV export escapes quotes **and** neutralises formula injection
- the asset tag keeps counting past `AF-9999` (numeric, not lexicographic)
- row-level scoping: an employee sees only their own overdue allocations,
  bookings and maintenance requests — someone else's booking answers `404`
- an asset cannot be marked `AVAILABLE` while it is still allocated, and a
  returned asset with an open maintenance request stays `UNDER_MAINTENANCE`
- malformed JSON columns (`documents`, `customFieldValues`) are rejected

---

## 🔒 Security model

| Area | How it is protected |
|------|--------------------|
| Passwords | bcrypt with a SHA-512 pre-hash (so passwords longer than bcrypt's 72-byte limit stay distinct), cost configurable, never returned by any endpoint |
| User enumeration | unknown e-mail and wrong password return the *same* message, and the same bcrypt work is performed in both cases |
| E-mail identity | addresses are normalised (trimmed + lower-cased) and compared case-insensitively — `A@x.com` and `a@x.com` are one account |
| Sessions | stateless JWTs; every request re-reads the user, so a deactivation or role change takes effect **immediately** |
| Google sign-in | the ID token is verified server-side (signature, issuer, audience, expiry) and the email must be verified by Google; the browser cannot assert an identity. The client id is public; no client secret exists. |
| Authorisation | `JwtAuthGuard` + `RolesGuard` on every route, plus department scoping inside the services |
| Brute force | per-account + per-IP sign-in limiter (`429`), plus a global per-IP throttle on every route |
| Injection | Prisma parameterises every query; DTOs are validated and stripped (`whitelist` + `forbidNonWhitelisted`) |
| Mass assignment | role changes are only possible through the dedicated admin endpoint; unknown body fields are rejected with `400` |
| Headers | `helmet` (clickjacking, MIME sniffing, …) and `X-Powered-By` removed |
| Transport | CORS restricted to an explicit origin allow-list; `trust proxy` enabled so rate limiting sees the real client IP behind Vercel |
| Secrets | the environment is validated at boot — a placeholder `JWT_SECRET` or a missing `DATABASE_URL` turns every route into a readable `503` (never an unreadable `500`) |
| CSV export | RFC-4180 quoting plus formula-injection neutralisation (`=`, `+`, `-`, `@` are prefixed) |

> **Known trade-off:** the JWT lives in `localStorage`, so any script running on
> the page can read it. The token itself carries no privilege — every request
> is authorised against the live user record — but an httpOnly cookie would be
> the stronger choice for a production rollout.

---

## 🚀 Deploying to Vercel

The repository deploys as **two Vercel projects from the same GitHub repo**:
one for the SPA (repository root) and one for the API (`backend/`).

### 0. Prerequisites

- A PostgreSQL database (a free [Neon](https://neon.tech) instance is ideal).
- The schema applied to it: `cd backend && npm run prisma:migrate`
  (or `npx prisma migrate deploy`).

> **Neon: pooled vs. direct.** Neon hands out two URLs. The **pooled** one
> (`…-pooler.…`) goes through PgBouncer and is perfect for the running API,
> but Prisma's migration engine and the Neon WebSocket driver need the
> **direct** one. Put the pooled URL in `DATABASE_URL` and the direct one in
> `DATABASE_URL_UNPOOLED` — `npm run prisma:migrate` then migrates over the
> direct connection automatically.

### 1. Deploy the API first

1. <https://vercel.com/new> → import the repository.
2. **Root Directory** → `backend`.
3. Leave the build settings alone — `backend/vercel.json` runs
   `npm run vercel-build` (`prisma generate && nest build`) and routes every
   request to the serverless entry point `backend/api/index.js`.
4. Add these **Environment Variables** (Production + Preview):

   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | your Postgres connection string (`…?sslmode=require` for Neon) — pooled **or** direct, the driver is chosen automatically |
   | `DATABASE_URL_UNPOOLED` | Neon's **direct** URL — needed for migrations only (optional if `DATABASE_URL` is already direct) |
   | `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
   | `JWT_EXPIRES_IN` | `7d` |
   | `GOOGLE_CLIENT_ID` | optional — the public client id from Google Cloud Console (see below) |
   | `CORS_ORIGINS` | fill in after step 2, then redeploy |
   | `NODE_ENV` | `production` |

   Do **not** set `PORT` — Vercel manages it.
5. Deploy and confirm the API answers on **both** paths:

   ```bash
   curl https://<api-project>.vercel.app/api          # → Hello World!
   curl https://<api-project>.vercel.app/api/health   # → { "status": "ok", "database": "up", … }
   ```

   `/api/health` is public and never blocked — it is the fastest way to see
   whether the deployment is configured correctly and whether the database is
   reachable.

### 2. Deploy the frontend

1. Import the **same repository** as a second Vercel project.
2. **Root Directory** → the repository root. `vercel.json` runs the Vite build
   and rewrites every path to `index.html`, so deep links like `/Dashboard`
   work.
3. Add one environment variable:

   | Key | Value |
   |-----|-------|
   | `VITE_API_BASE_URL` | `https://<api-project>.vercel.app/api` |

4. Deploy.

### 3. Close the CORS loop

In the **API** project set
`CORS_ORIGINS=https://<frontend-project>.vercel.app` (comma-separate extra
origins, no trailing slash) and redeploy. Without it the browser blocks every
API call.

### 3b. Enable Google sign-in (optional)

Create the **Web application** OAuth client described in the
**Sign in with Google** section above, add
`https://<frontend-project>.vercel.app` to its **Authorized JavaScript
origins**, then set `GOOGLE_CLIENT_ID` in the **API** project and redeploy.
The frontend needs no rebuild — it asks the API for the id at runtime.

### 4. Verify

Open the frontend URL, sign in as `admin@assetflow.com` / `password123` and
confirm the dashboard loads live data. If requests fail, check the API
project's runtime logs.

> **Neon connectivity:** `PrismaService` inspects `DATABASE_URL` and picks the
> driver itself — a **direct** `*.neon.tech` host is routed through
> `@prisma/adapter-neon`, which tunnels Postgres over WebSocket on port 443
> (required on networks that block raw Postgres TCP 5432); a **pooled**
> `*-pooler.*` host and every other host use `@prisma/adapter-pg` (`pg`),
> which is also what your local Docker Postgres uses. A pooled URL does
> **not** speak the Neon WebSocket protocol — that mismatch used to crash the
> serverless function at boot.

> **The two-project domain map (this deployment):**
>
> | Project | Domain | Role |
> |---------|--------|------|
> | `odoohackathon` | `odoohackathon-ten.vercel.app` | the API (`/api`) |
> | `odoohackathon-ujkn` | `odoohackathon-ujkn.vercel.app` | the SPA |
>
> The SPA needs `VITE_API_BASE_URL=https://odoohackathon-ten.vercel.app/api`
> and the API needs
> `CORS_ORIGINS=https://odoohackathon-ujkn.vercel.app` (Production **and**
> Preview, no trailing slash) — then redeploy both.

---

## 🧱 Self-hosted infrastructure

The Vercel deployment above is the *serverless* variant. This is the
**self-hosted** one: the API, the database, the cache and the monitoring run
as containers on one Ubuntu host, behind Nginx with TLS.

```
internet ──▶ nginx (443, TLS) ──┬──▶ api (4000) ──▶ postgres
                                │                  └▶ redis
                                └──▶ the built React SPA (static files)

prometheus ──▶ api, node-exporter, postgres-exporter     (internal network)
grafana    ──▶ prometheus                                  (127.0.0.1 only)
alertmanager ─▶ telegram
```

| What | Where |
|------|-------|
| The compose stack (production shaped) | [`infra/docker-compose.yml`](infra/docker-compose.yml) |
| The images (multi-stage, non-root) | [`infra/docker/`](infra/docker) |
| Nginx, TLS, the security headers | [`infra/nginx/`](infra/nginx) |
| Prometheus, the alert rules, Grafana | [`infra/prometheus/`](infra/prometheus), [`infra/grafana/`](infra/grafana) |
| The backup, the restore check, the archive, the hardening | [`infra/scripts/`](infra/scripts) |
| The nightly timers | [`infra/systemd/`](infra/systemd) |
| The CI pipeline (lint, tests, shellcheck, images) | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| The deployment over SSH with an automatic rollback | [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) |

```bash
cp infra/.env.example infra/.env        # the secrets, the ports, the S3 bucket, Telegram
sudo infra/scripts/issue-cert.sh --self-signed

docker compose -f infra/docker-compose.yml \
               -f infra/docker-compose.local.yml up -d --build
# → https://localhost:8443  ·  Grafana: http://localhost:3001  ·  Prometheus: http://localhost:9090
```

The ports come from `infra/.env` (`HTTP_PORT`, `HTTPS_PORT`) — the local
override opens the API port and removes the resource limits, it never repeats
a port of the base file (compose appends lists, and that is a port conflict).
The whole guide is in [`infra/README.md`](infra/README.md).

**What it demonstrates**

| Area | Where |
|------|-------|
| Linux & Bash | `set -euo pipefail`, idempotent scripts, `--dry-run` everywhere, systemd timers |
| Containers | a multi-stage, non-root image with a health check, resource limits, an internal network for the data |
| Networking | one public entry point, TLS, the security headers, the database without a route to the internet |
| Observability | `GET /api/metrics`, one JSON log line per request with a request id, a provisioned Grafana dashboard, 7 alert rules |
| Reliability | a nightly `pg_dump` → S3, a **restore verification every week**, an automatic rollback on a failed deployment |
| Cost | a budget alarm first, a lifecycle rule for the archive, an instance size derived from a measured load test |
| Data lifecycle | the old rows of a table are exported to compressed NDJSON in S3 with a manifest — deleted only after the manifest was verified |

**The documentation** — the part an interviewer reads:
[architecture](docs/ARCHITECTURE.md) ·
[runbook](docs/RUNBOOK.md) ·
[DR drill](docs/DR_DRILL.md) ·
[decisions](docs/DECISIONS.md) ·
[costs](docs/COSTS.md) ·
[AWS setup](docs/AWS_SETUP.md) ·
[interview Q&A](docs/INTERVIEW_QA.md) ·
[resume evidence](docs/RESUME_EVIDENCE.md) ·
[learning log](docs/LEARNING_LOG.md)

> **What this does not cover** — on purpose, and documented in
> [the decision log](docs/DECISIONS.md): no Kubernetes, no Terraform, no
> multi-AZ, no point-in-time recovery (the backups are logical dumps), no
> secrets manager, no log aggregation, no CDN. Every one of those is a
> product of its own to operate — and each of them needs a reason that this
> project does not have yet.

---

## 📁 Project layout

```
assetflow/
├── src/                       # React SPA
│   ├── components/
│   │   ├── dashboard/         # 15 feature screens
│   │   └── ui/                # shadcn/ui primitives
│   ├── lib/                   # api client, auth session, utils
│   ├── pages/                 # AuthLayout / AuthPage / Dashboard
│   ├── services/              # organisation service layer
│   └── test/                  # Vitest setup
├── backend/                   # NestJS API
│   ├── prisma/
│   │   ├── schema.prisma      # the data model (single source of truth)
│   │   ├── migrations/        # replayed verbatim by the test-suite
│   │   └── seed.ts            # idempotent demo data
│   ├── src/
│   │   ├── config/            # environment validation
│   │   ├── common/            # security helpers, scopes, Redis, logging
│   │   ├── metrics/           # the Prometheus endpoint
│   │   ├── auth/ assets/ allocations/ bookings/ maintenance/
│   │   ├── audits/ org/ reports/ notifications/ activity/
│   │   └── prisma/            # driver-adapter aware PrismaService
│   └── test/                  # Jest e2e suites + embedded Postgres
├── infra/                     # the self-hosted deployment (see above)
│   ├── docker/                # the two images
│   ├── nginx/ prometheus/ grafana/ alertmanager/
│   ├── scripts/               # backup, restore check, archive, hardening
│   └── systemd/               # the timers
├── docs/                      # architecture, runbook, DR drill, costs, AWS
├── .github/workflows/         # CI + the deployment over SSH
├── vercel.json                # SPA build + SPA rewrite
└── backend/vercel.json        # API build + serverless rewrite
```

---

## 🩺 Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `500 FUNCTION_INVOCATION_FAILED` on every route | the function crashed while booting (invalid env, missing bundle file, unreachable database) | the API now answers with a readable JSON error — open the Vercel runtime logs, or call `/api/health` and read `startupError` |
| `DATABASE_URL is not set` | `backend/.env` missing | `cp backend/.env.example backend/.env` |
| `JWT_SECRET must be at least 32 characters` | the production secret is a placeholder or too short | generate a 48-byte one (see [parameters](#-environment-variables--every-parameter)) and redeploy |
| `relation "User" does not exist` (or any `… does not exist`) | the migrations were never applied to that database | `cd backend && npm run prisma:migrate` with `DATABASE_URL_UNPOOLED` pointing at the **same** database |
| `Neon: … WebSocket / not supported` / `the connection attempt failed` | a **pooled** URL was used with the WebSocket driver | either use the direct `*.neon.tech` URL, or keep the pooled URL — the driver is chosen automatically now |
| `/api/health` returns `503` with a message | the environment is invalid — the message names the exact variable | fix the variable named in `startupError` and redeploy |
| `JWT_SECRET must be …` at boot | placeholder secret with `NODE_ENV=production` | generate a real one (see [parameters](#-environment-variables--every-parameter)) |
| The Google button is disabled | `GOOGLE_CLIENT_ID` is empty (or the API restarted without it) | set it in the API environment and restart; `GET /api/auth/config` shows `{"googleClientId": null}` until then |
| Google sign-in says "origin is not allowed" | the page origin is missing from the OAuth client | add it under **Authorized JavaScript origins** (exact scheme + host, no path) |
| `Could not locate the Query Engine` | the Prisma client was not generated | `cd backend && npx prisma generate` |
| `prisma: command not found` (exit 127) in a Vercel build | the CLI was invoked outside npm | keep the build command empty so `backend/vercel.json` is used |
| Every browser call fails with a CORS error | `CORS_ORIGINS` does not contain the frontend origin | add it (no trailing slash, Production **and** Preview) and redeploy the API |
| The SPA cannot reach the API | `VITE_API_BASE_URL` is wrong | it must include the `/api` prefix — and it is inlined at build time, so rebuild |
| `Unique constraint failed on assetTag` | a tag was created outside the API | tags are generated inside a transaction with a numeric `MAX()` — retry the request |
| Sign-in returns `429` | the brute-force limiter kicked in | wait `AUTH_THROTTLE_TTL` (15 min) or reset the account |
| Port 4000 already in use | another process owns it | `PORT=4100 npm run start:dev` and point `VITE_API_BASE_URL` at it |
| `npm warn allow-scripts` | npm 11 lists packages with install scripts | warnings only — bcrypt ships prebuilt binaries |

---

## 📄 License

Released under the **MIT License** — see [`LICENSE`](LICENSE) if present, or
the licence header of your fork.

<div align="center">

**Built with ❤️ for the Odoo Hackathon — AssetFlow**

</div>

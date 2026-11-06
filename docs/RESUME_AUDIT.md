# Resume audit — every claim, checked against the code

**Audited:** `main` @ `d334162` (after PR #13, the light/dark theme).
**Method:** read the code, then *re-measure* every number in this tree — no number below is
copied from an older document. Section 8 lists the command behind each figure.

**Verdicts**

| | Meaning |
|---|---|
| ✅ | True as written — the code and a measurement both say so |
| ⚠️ | Roughly true but the number or the phrasing is off — reword |
| ❌ | Wrong — the repo contradicts it |
| ❓ | Cannot be checked from this repository |

---

## 1. AssetFlow — Frontend

### 1.1 “Built a 13-screen React 18/TypeScript app (10 views, 3 role dashboards, ~14.4k lines, 8 chart components)”

**⚠️ three of the four numbers are off**

| Part | Measured | Verdict |
|---|---|---|
| React 18 | `react@^18.3.1`, `react-dom@^18.3.1`, TypeScript 5.6.3 | ✅ |
| 13 screens | **12** lazily-loaded views (3 role dashboards + 9 feature screens) **+ 2 auth screens** = 14 routed screens | ⚠️ |
| “10 views, 3 role dashboards” | 9 views + 3 dashboards. Ten is the *sidebar* count, not the view count | ❌ arithmetic |
| ~14.4k lines | **14,899 lines / 56 files** (13,850 excl. specs, 1,049 spec) | ⚠️ say ~14.9k |
| 8 chart components | **8 chart instances** — 4 bar, 2 area, 2 pie — across **4** view files (Reports 4, Manager 2, Admin 1, Employee 1) | ✅ if “instances” |

**Evidence:** `src/pages/Dashboard.tsx` (12 `const X = lazy(...)`), `src/App.tsx:36-52`
(`/signin`, `/signup`, `/Dashboard`, `/`, `*`), `package.json`, `find src -name '*.ts*' | wc -l`,
`grep -rhoE "<(Bar|Area|Pie)Chart" src`.

**Say it like this:**
> *Built a 14-screen React 18/TypeScript app — 12 lazily-loaded views including 3 role
> dashboards, plus sign-in and sign-up — ~14.9k lines, 8 chart instances (bar/area/pie) that
> ship as a deferred 96 kB chunk.*

**Keywords:** React 18, TypeScript, React.lazy + Suspense, route-level code splitting,
Recharts, role-based routing.

---

### 1.2 “Navigation and permitted actions follow a role re-read from the API on every load, so a deactivation takes effect at once”

**✅ true, with one honest caveat**

- The shell calls `getMe()` on mount and re-derives the role for the sidebar and the actions —
  `src/pages/Dashboard.tsx`, `src/lib/auth.ts`, `NAVIGATE_MAP`.
- The server is the real gate: `backend/src/auth/jwt.strategy.ts:42` rejects any token whose
  user is `INACTIVE` (`if (!user || user.status === RecordStatus.INACTIVE) throw
  new UnauthorizedException()`). So the *next request* fails immediately, whatever the UI shows.
- Caveat: an already-open tab keeps its stale UI until that request (the dashboards poll every
  60 s).

**Say it like this:**
> *The role is re-read from the API on every load and the server re-checks it on every request,
> so deactivating a user invalidates their very next call rather than waiting for a token to expire.*

**Keywords:** RBAC, authorization, token invalidation, 401 handling.

---

### 1.3 “Cut first-load JavaScript from 294 kB to 120 kB gzipped (about 60%) via route-level code splitting and on-demand charts”

**❌ the 120 kB is stale; the percentage follows from it**

| | Value |
|---|---|
| Before | 1,089 kB raw / **294 kB gzip**, one file — `docs/FRONTEND.md:95` ✅ |
| Now (this build) | **143.8 kB gzip** first load |
| Reduction | **51 %**, not 60 % |

Current first load, measured on this commit: React 48.7 + Motion 41.1 + vendor 27.7 + CSS 9.0
+ app 8.9 + icons 7.0 + ui 1.4 = **143.8 kB gz**. Recharts is a separate **96.2 kB gz** chunk
that is requested only when a chart draws; each view is 2.64–10.16 kB gz on top.

**Say it like this:**
> *Cut first-load JavaScript from 294 kB to 144 kB gzipped (51 %) by splitting the views and
> moving Recharts into a deferred 96 kB chunk.*

**Keywords:** code splitting, manualChunks, gzip budget, deferred/lazy chunk, cache invalidation.

---

### 1.4 “One typed API client for 104 call sites”

**❌ 76, not 104**

`src/lib/api.ts` is the single typed client (a `fetch` wrapper with a 20 s `AbortController`
timeout, JSON handling and a 401 → `handleUnauthorized()` + `?next=` redirect).
Call sites: **76** `apiGet`/`apiSend` invocations across **16 files** (78 occurrences − the 2
definitions). Separately, **5** raw `fetch()` calls live *outside* the client
(`api/assetServices.ts`, the CSV export in `ReportsAnalytics.tsx`, and three in `lib/auth.ts`).

**Say it like this:**
> *One typed API client handling 76 call sites, with a shared timeout and a single 401 → re-auth path.*

**Keywords:** typed API layer, fetch wrapper, AbortController, timeout, error normalisation.

---

### 1.5 “7 UI primitives built using user-centered design principles, with light/dark theming and loading, empty and error states”

**✅ for the primitives, the theming and the states — ❓ for “user-centered design principles”**

| Part | Evidence |
|---|---|
| 7 primitives | `src/components/ui/`: `button`, `dialog`, `field`, `input`, `label`, `search-dropdown`, `theme-toggle` = **7** (+ `auth-switch`, `error-boundary` = 9 components in that folder) |
| light/dark theming | built and merged in PR #13: **41** light tokens, **24** dark overrides in `src/index.css`, `darkMode: ["class"]`, an inline no-flash script in `index.html`, a persisted toggle (`assetflow-theme`), `useTheme` hook, 15 tests |
| contrast | **32/32** colour pairs meet their WCAG minimum in *both* themes (`scripts/contrast-audit.py`, gated in CI) |
| loading / empty / error states | 14 distinct empty-state strings, 16 `role="alert"` + 3 `role="status"`, toasts in 9 files, an `ErrorBoundary`, `Suspense` fallbacks with an announced “Loading…” |
| “user-centered design principles” | no artefact — ❓ subjective |

**Say it like this:**
> *7 UI primitives on one design-token layer with light/dark theming (32/32 contrast pairs
> checked in CI), plus explicit loading, empty and error states.*

**Keywords:** design tokens, dark mode, CSS variables, Tailwind, accessibility audit, empty
states, error boundaries.

---

### 1.6 “Accessibility & Usability: One reusable modal dialog (aria-modal, focus trap, Escape, focus return; 8 tests), a keyboard-driven WAI-ARIA combobox (7 keyboard-only tests), labelled form fields and a skip link; mapped to WCAG 2.1 AA, gaps documented”

**✅ every part checks out**

| Claim | Evidence |
|---|---|
| One reusable dialog, `aria-modal`, focus trap, Escape, focus return | `src/components/ui/dialog.tsx`; used in 5 files (replacing ad-hoc overlays) |
| 8 tests | `src/components/ui/dialog.spec.tsx` → `grep -cE "^\s*it\("` = **8** |
| Combobox, 7 keyboard-only tests | `src/components/ui/search-dropdown.tsx` + `.spec.tsx` = **7** tests, all keyboard/ARIA (arrow keys, wrap-around, Enter, Escape restores focus, type-to-filter, open with keyboard alone) |
| Labelled fields | `label.tsx` / `field.tsx`, 10 `htmlFor` |
| Skip link | `src/components/dashboard/DashboardLayout.tsx:49` |
| Mapped to WCAG 2.1 AA, gaps documented | `docs/ACCESSIBILITY.md` (measured 1.4.3 contrast, 1.4.11 gap, no axe scan) |

Do **not** upgrade this to “WCAG 2.1 AA compliant” — there is no axe scan and no recorded
screen-reader session, and `docs/ACCESSIBILITY.md` says so.

**Keywords:** WAI-ARIA, focus management, focus trap, keyboard navigation, skip link,
WCAG 2.1 AA, 1.4.3 contrast, 4.1.2 name/role/value.

---

### 1.7 “52 frontend” tests (inside the Security & Testing bullet)

**❌ it is 67**

`npm test` on this commit: **67 passed / 67, 9 files** (Vitest 2.1.9 + Testing Library 16,
jsdom). The count moved when the theme shipped (+15 tests).

---

## 2. AssetFlow — Backend

### 2.1 “NestJS backend with 79 REST endpoints, a 13-model PostgreSQL schema and JWT RBAC across 4 roles”

**⚠️ 78 endpoints; the schema and the roles are exact**

| Part | Measured | Verdict |
|---|---|---|
| 79 REST endpoints | **78** route handlers in **15 controllers**, all under the global `/api` prefix | ⚠️ off by one |
| 13-model PostgreSQL schema | **13 models**, **12 enums**, 18 `@@index`, 2 composite `@@unique`, 5 single `@unique`, 3 migrations | ✅ |
| JWT RBAC, 4 roles | `Role = ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD, EMPLOYEE`; 41 `@Roles(...)` decorators; `JwtAuthGuard` + `RolesGuard` on the controllers; department scoping in `src/common/auth/scopes.ts` | ✅ |

Per-domain handlers: reports 13, allocations 5 + transfers 4, maintenance 9, audits 8,
org 14 (employees 6, categories 4, departments 4), bookings 6, assets 5, auth 5,
notifications 4, health 2, activity 1, metrics 1, root 1 = **78**.

**Say it like this:**
> *NestJS backend with 78 REST endpoints over a 13-model PostgreSQL schema, with JWT auth and
> role checks across 4 roles.*

**Keywords:** NestJS, REST, Prisma, PostgreSQL, JWT, RBAC, guards, DTO validation.

---

### 2.2 “allocations and bookings are conflict-safe under simultaneous requests”

**⚠️ implemented, but never *tested* with two simultaneous requests**

- 18 `$transaction` blocks in the services; **4 `SELECT … FOR UPDATE`** row locks —
  `allocations.service.ts:78`, `:588` and `bookings.service.ts:94`, `:255` — each with a comment
  explaining that the second writer waits, then sees the first one’s row and is rejected.
- Booking overlap is re-checked inside the lock (`bookings.service.ts:292-316` → 409).
- Asset tags are allocated by a numeric `MAX()` read inside a transaction with a P2002 retry
  loop (`assets.service.ts:60-100`, `nextAssetTag`), so two simultaneous creates cannot mint
  the same `AF-0001`.
- The e2e suite covers the *sequential* conflicts: `allocations.e2e-spec.ts:105` (“rejects a
  second allocation of the same asset (409)”), `:270` (double return), `:411` (approve twice),
  `bookings.e2e-spec.ts:122` (overlapping booking → 409). **No test fires two requests in
  parallel** — `grep Promise.all test/*.e2e-spec.ts` finds nothing.

**Say it like this:**
> *Allocations and bookings take a row lock before their conflict check, so a second request
> cannot slip between the check and the write.*

…or add a two-request test and then use “verified under simultaneous requests”.

**Keywords:** row-level locking, `SELECT … FOR UPDATE`, transaction, race condition,
check-then-write, unique constraint, retry on P2002.

---

### 2.3 “workflows reject invalid transitions with 409”

**✅ true**

30 `ConflictException` throws; explicit status guards, e.g. `maintenance.service.ts:106, 162,
198, 227` (approve/assign/start/resolve only from the right predecessor state),
`bookings.service.ts:196-252` (cancel/reschedule). State enums: maintenance 6 states, transfer 4,
booking 4, allocation 2, audit 2, asset 7.

**Keywords:** state machine, invalid transition, HTTP 409, idempotency, workflow.

---

### 2.4 “bcrypt + SHA-512 pre-hash (fixes 72-byte truncation), Redis-backed brute-force throttling, DTO whitelisting”

**✅ all three, with one caveat on where Redis is actually on**

| Part | Evidence |
|---|---|
| bcrypt + SHA-512 pre-hash | `src/common/security/password.ts`: `preHash = sha512 hex` → `bcrypt.hash(…, rounds)`, `rounds = 12`, `BCRYPT_MAX_BYTES = 72`; legacy raw-bcrypt hashes still verify |
| Redis-backed brute-force throttling | `src/auth/login-throttle.service.ts` + `login-throttle.store.ts` (both unit-tested); `src/common/rate-limit/redis-throttler.storage.ts` is the Throttler storage; `UserThrottlerGuard` is a global `APP_GUARD`; re-keyed from IP to user (`throttle-key.ts`) |
| DTO whitelisting | `configure-app.ts`: `ValidationPipe({ whitelist, forbidNonWhitelisted, transform, forbidUnknownValues })`; **36** DTO files, 111 `@IsOptional`, 64 `@IsString`, 24 `@IsEnum`, 2 custom validators (`json-fields.ts`) |

**Caveat to know before an interview:** on the live Vercel deployment the rate limiter falls back
to `{"rateLimitStore":"memory","redis":"disabled"}` (`/api/health`) — Redis is only active in the
Docker Compose stack. If asked “where does Redis run?”, the answer is the EC2/Compose host, not
the Vercel demo.

**Keywords:** bcrypt cost factor, SHA-512 pre-hash, 72-byte truncation, rate limiting,
throttler, Redis, brute force, allow-list validation, class-validator.

---

### 2.5 “238 automated checks (72 unit, 114 e2e on embedded PostgreSQL, 52 frontend) and an ESLint gate with zero any”

**⚠️ every count moved; only the ESLint claim is exact**

| | Resume | Measured now |
|---|---|---|
| Unit | 72 | **72** ✅ (11 suites) |
| E2E on embedded PostgreSQL | 114 | **117 passed + 1 skipped = 118** (14 suites, 3,201 lines, PGlite replaying the real migrations) |
| Frontend | 52 | **67** (9 files) |
| Total | 238 | **256** |
| ESLint, zero `any` | — | ✅ backend `eslint` exit 0 / no findings; frontend **0 errors, 16 warnings**; `grep ': any'` = 1 hit and it is inside a comment |

**Say it like this:**
> *256 automated checks — 72 unit, 118 e2e (117 passing, 1 skipped) against an embedded
> PostgreSQL that replays the real migrations, 67 frontend — with an ESLint gate and no `any`
> types.*

**Keywords:** Jest, PGlite, embedded Postgres, e2e, Vitest, Testing Library, ESLint,
type safety, CI gate.

---

## 3. AssetFlow — Self-hosted infrastructure

### 3.1 “Deployed on AWS EC2 (t3.micro) with Docker Compose (10 services: 9 long-running + 1 migration job) behind Nginx with Let’s Encrypt TLS; nightly pg_dump to encrypted S3, restore from S3 verified in 14 s against production; modelled cost $12.04/month”

**⚠️ accurate except the host address (see 3.4) and “encrypted” (configured in the console, not in code)**

| Part | Evidence |
|---|---|
| EC2 `t3.micro` | `infra/README.md:107`, `docs/AWS_SETUP.md:138`, `docs/COSTS.md:26` |
| Compose, 10 services (9 + `migrate`) | `infra/docker-compose.yml` → `api, postgres, redis, migrate, nginx, prometheus, alertmanager, grafana, node-exporter, postgres-exporter` |
| Nginx + Let’s Encrypt | `infra/docker/Dockerfile.nginx`, `infra/scripts/issue-cert.sh`, `renew-cert.sh` (sslip.io) |
| Nightly pg_dump → S3 | `infra/scripts/backup.sh` (`pg_dump --format=custom`, sha256, `aws s3 cp`), `infra/systemd/assetflow-backup.timer` |
| “encrypted S3” | **not in code** — it is a console step in `docs/AWS_SETUP.md:91-120`: private bucket, SSE-S3 (AES-256), versioning, Glacier IR after 30 days, TLS-only bucket policy. Machine-verifiable only up to “the object came back” |
| Restore from S3 in 14 s | `docs/results/restore-from-s3-20261028T181200Z.txt` — “the restore took 14 seconds (RTO)”, dump 44 KiB, checksum matched; 8 s when the dump is already local |
| $12.04 / month | `docs/COSTS.md:33` |

**Say it like this:**
> *Deployed on AWS EC2 (t3.micro) with Docker Compose — 10 services, 9 long-running plus a
> one-shot migration job — behind Nginx with Let’s Encrypt TLS; a nightly pg_dump goes to a
> private, SSE-S3-encrypted, versioned S3 bucket, and a restore pulled back from S3 was verified
> in 14 s; modelled cost $12.04/month.*

**Keywords:** EC2, Docker Compose, Nginx, Let’s Encrypt, TLS, pg_dump, S3, SSE-S3, RTO,
disaster recovery, cost model.

---

### 3.2 “Prometheus (3 targets, 11 alert rules) to Alertmanager to Telegram, a Grafana dashboard as code and JSON logs with request-ID tracing”

**✅ exact**

- `infra/prometheus/prometheus.yml` — **3** scrape jobs: `assetflow-api` (`/api/metrics`), `node`
  (node-exporter:9100), `postgres` (postgres-exporter:9187).
- `infra/prometheus/rules/assetflow.yml` — **11** alerts: ApiDown, HighErrorRate, HighLatency,
  HostDiskAlmostFull, HostDiskFull, HostMemoryPressure, HostCpuSaturated, PostgresDown,
  PostgresConnectionsHigh, BackupTooOld, ThrottleStoreDegraded.
- Alertmanager → Telegram: `infra/alertmanager/`, evidence `docs/results/telegram-alert-20261028T181000Z.txt`.
- Grafana as code: `infra/grafana/dashboards/assetflow.json` + provisioning.
- JSON logs + request IDs: `src/common/logging/json-logger.ts`,
  `src/common/http/request-context.middleware.ts`; asserted in
  `test/observability.e2e-spec.ts:38-41` (`x-request-id` echoed from the proxy).
- Custom metrics: `prom-client` counter + histogram + 2 gauges (`metrics.service.ts`).

**Keywords:** Prometheus, exporters, alerting rules, Alertmanager, Telegram, Grafana
provisioning, structured logging, request correlation, RED metrics.

---

### 3.3 “Found the rate limiter keyed on client IP, so everyone behind one address shared 300 req/min (300 OK, then request 301 returned 429); re-keyed it to the user. CI runs lint, shellcheck and 238 tests; failed deploys roll back automatically”

**⚠️ tests are 256 now; the rollback exists but has never been exercised**

| Part | Verdict | Evidence |
|---|---|---|
| 300 OK then 429 with `Retry-After` | ✅ | `docs/results/rate-limit-20261105T083630Z.txt`; `THROTTLE_LIMIT`/`THROTTLE_BLOCK_MS`, the second asserted in a unit test |
| re-keyed from IP to user | ✅ | `src/common/rate-limit/throttle-key.ts` + `.spec.ts`, `user-throttler.guard.ts` |
| CI runs lint, shellcheck, tests | ✅ | 3 jobs: `backend` (lint, unit, e2e, build), `frontend` (lint, typecheck, tests, build, contrast), `infra` (shellcheck of 13 scripts, compose validation, both images) |
| “238 tests” | ⚠️ | **256** |
| “failed deploys roll back automatically” | ⚠️ | `infra/scripts/deploy.sh:106-111` rolls back to the previous image when the health check fails — **there is no recorded rollback run**, so no time-to-rollback figure is quotable |

**Keywords:** rate limiting, key by identity vs IP, 429 + Retry-After, shellcheck, CI pipeline,
health-check gate, automatic rollback.

---

### 3.4 “Infra: 13.55.90.25”

**❌ stale address**

The Elastic IP in use is **3.107.83.86** (`DEPLOY_HOST` in the deploy workflow). Replace the
IP, or drop it from the resume entirely — a dead IP on a resume is the first thing an
interviewer clicks.

---

## 4. Numbers in the summary and the skills block

| Claim | Verdict | Note |
|---|---|---|
| “400+ automated checks” | ⚠️ | This repository holds **256** (72 + 118 + 67 − 1 skipped). The rest are in VendorBridge, which is frozen and was not re-audited |
| “250+ LeetCode problems” | ❓ | outside the repo |
| “JEE 98.04 percentile”, “GPA 7.69”, “87 % / 92 %”, certifications | ❓ | outside the repo |
| “…on AWS with Docker and CI/CD” | ✅ | EC2 + Compose + GitHub Actions, both workflows in `.github/workflows/` |
| “PostgreSQL (row-level locking, triggers)” in skills | ⚠️ **triggers are VendorBridge, not AssetFlow** | AssetFlow has **0** `CREATE TRIGGER` in its 3 migrations (row locks: yes, 4 sites). Don’t let the two projects get merged in an answer |
| “Redis” in the AssetFlow stack line | ✅ with the caveat in 2.4 | active in Compose, disabled on Vercel |

---

## 5. Could not verify

1. **“built using user-centered design principles”** (1.5) — no artefact: no usability session,
   no heuristics write-up, no user feedback. Either drop it or replace it with something true
   (token system, 32/32 contrast, empty/error states).
2. **Every VendorBridge bullet** — 40+ endpoints, 18-table schema, database triggers, 227 API +
   182 browser tests, 10,000 generated purchase orders, Upstash fail-open cache. The project is
   frozen and was not audited in this pass; none of those numbers were re-measured here.
3. **The smart-grid project** — C++, ESP32, MQTT, Isolation Forest, Streamlit: not in this repo.
4. **The 294 kB “before” figure** — recorded in `docs/FRONTEND.md:95` from the pre-split build;
   the *current* 143.8 kB is measured, the historical 294 kB is a documented past measurement,
   not re-runnable from this commit.
5. **“Deactivation takes effect at once”** — true for the next API call; an open tab shows stale
   UI until it polls (60 s). Not measurable as “at once” from the UI.
6. **Recruiter-facing items** — education, certifications, LeetCode count, SIH ranking.

---

## 6. Real gaps found while auditing

These are defects in the *project*, not in the resume. They are the honest “what is not done yet”.

| # | Gap | Where |
|---|---|---|
| 1 | ~~Doc arithmetic: “10 navigation screens + 3 role dashboards = 12 lazily-loaded views”~~ — **fixed in this commit** to “9 navigation screens + 3 role dashboards = 12 views, reached from 10 sidebar entries” | `docs/FRONTEND.md:13` |
| 2 | No test drives two requests at once, so the row locks are argued, not demonstrated | `test/*.e2e-spec.ts` |
| 3 | Rollback is implemented but never exercised; the “48 s” figure has no evidence file | `infra/scripts/deploy.sh`, `docs/` |
| 4 | `border-line` at 1.5:1 on roughly 40 inline sites — a WCAG 1.4.11 (non-text contrast) gap | `docs/ACCESSIBILITY.md` §3a |
| 5 | No visual-regression or headless-browser test; the views’ rendering is untested | frontend |
| 6 | Live Vercel deployment runs the rate limiter in memory, not Redis | `/api/health` |
| 7 | Compose `api` service has no default `DATABASE_URL` | `infra/docker-compose.yml` |
| 8 | No OpenAPI/Swagger; the API is documented by hand | `backend/API.md` (216 lines) |
| 9 | No queue, no outbound e-mail, no file upload — `photoUrl`/`documents` are URLs only | backend |
| 10 | 1 e2e test is skipped | `test/` |

---

## 7. The eight changes to make before sending

Copy-paste replacements. Order and structure stay exactly as they are.

| # | Was | Becomes |
|---|---|---|
| 1 | `13-screen React 18/TypeScript app (10 views, 3 role dashboards, ~14.4k lines, 8 chart components)` | `14-screen React 18/TypeScript app (12 lazily-loaded views including 3 role dashboards, ~14.9k lines, 8 chart instances)` |
| 2 | `from 294 kB to 120 kB gzipped (about 60%)` | `from 294 kB to 144 kB gzipped (51%)` |
| 3 | `one typed API client for 104 call sites` | `one typed API client for 76 call sites` |
| 4 | `7 UI primitives built using user-centered design principles` | `7 UI primitives on one design-token layer` |
| 5 | `79 REST endpoints` | `78 REST endpoints` |
| 6 | `conflict-safe under simultaneous requests` | `serialised with row-level locks so a second request cannot slip between check and write` |
| 7 | `238 automated checks (72 unit, 114 e2e on embedded PostgreSQL, 52 frontend)` | `256 automated checks (72 unit, 118 e2e on embedded PostgreSQL, 67 frontend)` |
| 8 | `Infra: 13.55.90.25` | `Infra: 3.107.83.86` |

Two smaller ones:

- “Redis-backed brute-force throttling” → keep, but be ready to say *which* deployment runs Redis
  (Compose, not Vercel).
- “CI runs lint, shellcheck and 238 tests” → `256 tests`.

---

## 8. How to reproduce every number

Plain commands, run from the repo root unless stated.

```bash
# Frontend size and tests
cd ~/assetflow
find node_modules -maxdepth 1 -mindepth 1 | wc -l          # 331 installed packages
find src -name '*.ts' -o -name '*.tsx' | wc -l              # 56 files
cat $(find src -name '*.ts' -o -name '*.tsx') | wc -l       # 14,899 lines
npm test                                                    # 67 passed, 9 files
npm run build                                               # then inspect dist/ chunk sizes
grep -rnoE "api(Get|Send)\(" src --include=*.ts --include=*.tsx | wc -l   # 78 occurrences − 2 definitions = 76
grep -rhoE "<(Bar|Area|Pie)Chart" src | sort | uniq -c      # 4 bar, 2 area, 2 pie
python3 scripts/contrast-audit.py --check                   # 32/32 pairs
grep -cE "^const [A-Za-z]+ = lazy" src/pages/Dashboard.tsx  # 12 views

# Backend size, endpoints and tests
cd backend
find src -name '*.ts' | wc -l                               # 106 files
grep -rn "@\(Get\|Post\|Patch\|Put\|Delete\)(" src --include=*.controller.ts | wc -l   # routes
npm run test:unit                                           # 72 passed, 11 suites
npm run test:e2e                                            # 117 passed, 1 skipped, 14 suites
npm run lint                                                # 0 findings
grep -rn 'FOR UPDATE' src --include=*.ts | wc -l            # 4 row locks
grep -rn '\$transaction' src --include=*.ts | grep -v spec | wc -l   # 18 transactions

# Infrastructure
node -e "…"                                                 # or: grep -E "^  [a-z-]+:" infra/docker-compose.yml  → 10 services
grep -cE "^\s+- job_name" infra/prometheus/prometheus.yml   # 3 targets
grep -c "alert:" infra/prometheus/rules/assetflow.yml       # 11 rules
cat docs/results/restore-from-s3-20261028T181200Z.txt       # 14 s restore
sed -n '20,40p' docs/COSTS.md                               # $12.04 / month
```

---

*Every figure in this file was measured on `d334162` (frontend, backend unit/e2e, contrast,
build, lint) or traced to the named evidence file. Where the code could not answer — concurrency
under load, a rollback that never ran, the frozen VendorBridge — it is listed as unverified
rather than estimated.*

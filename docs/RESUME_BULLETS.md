# Resume bullets — the DevOps half, and the frontend half

Every number below was measured on the live host or in the repository, and the
raw output is in [`results/`](./results). If a claim is not in this file, it is
not measured yet — see **Do not claim** at the bottom.

> **Two caveats on the numbers below.** The k6 transcript and the rollback
> transcript were excluded by a `.gitignore` rule and are **not in the
> repository** (fixed 2026-11-05, so future runs are committed) — re-run
> `infra/scripts/k6-test.sh` and the forced-failure deploy before quoting the
> 24.2 req/s and 48 s figures. And the deployment host is now
> **`3.107.83.86`** (Elastic IP, `https://3.107.83.86.sslip.io`); anything
> still showing `13.55.90.25` is stale.

## The five DevOps bullets

1. **Deployed the full stack on AWS EC2 (t3.micro) behind Nginx with Let's
   Encrypt TLS** — 10 Docker Compose services (9 long-running, plus a one-shot
   migration job that exits), multi-stage non-root images,
   PostgreSQL and Redis on an internal network with no published ports and
   monitoring bound to loopback only; modelled the run cost at **$12.04/month**
   instead of guessing it.

2. **Moved rate limiting and brute-force lockout out of process memory into
   Redis**, so the limits survive a restart and are shared across instances —
   the in-process counters reset on every deploy, which made the throttle
   bypassable; both paths fail open to a local counter and expose the
   degradation through `/health` and a Prometheus gauge. The ceiling is
   measured, not assumed: **300 requests a minute per user, request #301 is
   `429` with `Retry-After`** ([transcript](./results/rate-limit-20261105T083630Z.txt))
   — the first version of this limiter only counted, which the measurement
   caught (`DECISIONS.md` row 33).

3. **Built the observability path end to end** — Prometheus scraping 3 targets
   with **11 alert rules** → Alertmanager → Telegram, a Grafana dashboard
   provisioned as code, one JSON log line per request with a propagated
   `x-request-id`, plus `/metrics` and `/health/ready` probes; verified by
   firing synthetic alerts: **3 notifications delivered, 0 failures**.

4. **Automated backups with a restore that is tested, not assumed** — nightly
   `pg_dump` → S3 with versioning, SSE-AES256, public-access block, a TLS-only
   bucket policy and a lifecycle rule (30 d → Glacier Instant Retrieval, expire
   365 d); restore verified **from the S3 object in 14 s** with row-by-row
   comparison against production and a SHA-256 check.

5. **Sized the instance from evidence, and shipped it through CI** — a k6 run
   (25 VUs, 3 min) held **24.2 req/s at p95 35.4 ms, 0.00 % errors** over 4,392
   requests with peak CPU 43.9 %, which is how the t3.micro was chosen; GitHub
   Actions runs lint, shellcheck, **241 tests** and both image builds, and the
   deploy job goes build → GHCR → SSH → migrate → health check with an
   **automatic rollback (48 s, measured on a forced failure)**.

## The frontend half (the VISA software-engineering intern posting)

That posting asks for **HTML, CSS, JavaScript, responsive design,
accessibility (Section 508 / WCAG 2.0), user-centred design, usability and
object-oriented design** — so the frontend bullets are written against those
words, and every number in them is from this repository.

```
Frontend (AssetFlow) — React 18, TypeScript, Vite, Tailwind, React Router,
Recharts, Framer Motion, Vitest, ESLint
```

1. **Rebuilt every overlay as one accessible dialog component** — `role`,
   accessible name, focus trap, Escape, focus restored to the opener, the page
   behind frozen — so a keyboard user can no longer Tab out of a modal and a
   screen reader announces what opened; the behaviour is proven by **8 tests**
   and the form fields, error messages and 20 icon-only buttons were made to
   announce themselves in the same pass (WCAG 2.1 AA: 4.1.2, 2.4.3, 2.1.2,
   1.3.1, 3.3.1, 4.1.3).

2. **Made the searchable pickers usable without a mouse** — the WAI-ARIA 1.2
   combobox pattern (listbox of options, arrow keys, Home/End, Enter, Escape,
   a live count of the results): **7 tests** drive it with the keyboard only.

3. **Cut the first load by more than half without removing a feature** — the
   app was one 1,089 kB file (294 kB gzipped) that carried every screen plus
   Recharts and Framer Motion; it is now **143 kB gzipped** for the first
   screen, one 4–10 kB file per view loaded on demand, and the **96 kB
   gzipped** charts chunk only fetched when a chart is drawn. The last step was
   not `React.lazy`: the chunk list named packages, so Rollup had put recharts'
   own dependency (`clsx`, which the shell needs) inside the charts chunk, the
   entry imported it, and every visitor downloaded **118 kB gzipped of charting
   library before the sign-in page painted** — first load fell from 247 kB to
   143 kB gzipped once chunks were assigned by module path.

4. **Turned one hard-coded palette into a real light/dark theme** — the app was
   built against a single dark palette: ~2,300 colour utilities (`zinc`/`gray`
   shades, 282 arbitrary navy hexes) and a `.dark` block in the CSS that
   nothing ever switched on. The colours are now 12 tokens read from CSS
   variables, so both themes are one table each and no element carries a
   `dark:` variant; the switch remembers the choice, follows the operating
   system until the visitor picks one, paints before the bundle is fetched (no
   white flash) and is keyboard-operable with `aria-pressed`. Every text pair
   then measures **≥ 4.5:1 in both themes** — verified by
   `scripts/contrast-audit.py`, which parses the CSS and fails the build if a
   colour drops below AA — including two dark-theme colours that were
   **3.4:1 and 2.2:1** before.

5. **Stopped the dashboard from lying to itself** — a slow request used to
   overlap the next poll, so the older answer could win and the table jumped
   back; a hidden tab kept polling forever. One `usePolling` hook now guards
   the in-flight request, pauses while the tab is hidden and refreshes on
   return — **6 tests** with a fake clock.

6. **Removed every escape hatch the type system allowed** — 39 `any`s replaced
   by typed API records read through helpers that always return the right
   type, so a renamed field is a compile error instead of a blank column; and
   the frontend finally has a lint gate (ESLint 9 + the React hooks rules) in
   CI, which found 57 problems on the first run — 41 fixed, 16 documented.

7. **Made failure a designed state, not a blank page** — an error boundary with
   a retry, a 401 that clears the session and returns the user to the page
   they were on (with an open-redirect check), four destructive actions that
   ask first, and named messages for timeouts, an unreachable API and a
   validation array.

### If there is room for only two

Take **#1** (the accessible dialog — it is the one a design-systems interviewer
will probe) and **#4** (the themed palette: it is the only bullet where a
"feature" also produced a measurement — 4.5:1 in both themes, checked by a
script).

### Say it like this, in a minute

> The app has ten navigation screens and three roles. The two things I am proudest of
> are not features: the overlays were plain divs, so I rebuilt them as one
> dialog component with a focus trap, Escape and a focus restore, and put
> eight tests on it; and the bundle was one 1.1 MB file, so I split the views
> and the two heavy libraries and got the first screen down to 120 kB gzipped.
> What I have not done is an axe scan or a screen-reader session — that is in
> the known-gaps table in `docs/ACCESSIBILITY.md`, with the order I would fix
> it in.

### Frontend claims to avoid

| Tempting claim | Why not |
|---|---|
| "WCAG 2.1 AA certified / compliant" | no axe scan and no recorded screen-reader session yet; say "implemented the behaviours, with the gaps written down" |
| "tested with Playwright end to end" | the 52 tests are Vitest + Testing Library in jsdom; the views' rendering is not covered |
| "fully responsive" | the layouts reflow and the tables scroll; no device-matrix test exists — say what was fixed (drawer, KPI row, month grid, 16 px inputs) |
| "the frontend is 100 % type-safe" | `any` is gone from `src/`, but the API's runtime shape is still trusted (typed, not validated at the boundary) |
| "code-split to 120 kB" without the rest | 120 kB is the **first screen**; a dashboard with charts also fetches Recharts (118 kB gzipped) |

## If there is no room for five

Drop #1 (the platform) or #5 (the sizing) first — #2, #3 and #4 carry the
strongest evidence, because each one has a number that a broken implementation
could not produce: a lockout that survives a restart, an alert that actually
arrives, a restore that actually restores.

## One correction to the existing bullets

The auth bullet says "174 automated checks: 45 unit, 105 e2e, 24 frontend".
The suite grew during the infrastructure work. Measured on 2026-10-29:

```
backend  unit   72 passed, 11 suites
backend  e2e   114 passed, 13 suites
frontend       52 passed,  7 files
               238 total
```

Use **238 automated checks: 72 unit, 114 e2e on embedded PostgreSQL (PGlite),
52 frontend.** The commands are `npm run test:unit`, `npm run test:e2e` and
`npx vitest run` — an interviewer can reproduce all three in about a minute.

## Do not claim (not measured)

| Tempting claim | Why not |
|----------------|---------|
| "zero-downtime deploys" | the API container is replaced, so there is a gap of a few seconds; the rollback is what is proven |
| "every push deploys automatically" | the deploy workflow is skipped until `DEPLOY_HOST` is set; the rollback path itself is measured |
| "99.9 % uptime" | no uptime history has been collected |
| "the host rebuild takes N minutes" | the rebuild drill has not run yet — the IAM policy is missing ([REBUILD_DRILL](./REBUILD_DRILL.md)) |
| "auto-scaling / Kubernetes" | it is one instance and Docker Compose; say that, it is still a real deployment |
| "cut infra cost by X %" | there is no previous bill to compare against; quote the $12.04/month model instead |

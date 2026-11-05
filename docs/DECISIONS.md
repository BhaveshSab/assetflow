# The decision log

Every component answers one requirement of the job. If a component does not
answer one, it is not in the stack.

| # | Decision | The requirement it serves | The alternative we rejected |
|---|----------|--------------------------|-----------------------------|
| 1 | **One host, containers** | "run the infrastructure on-site and in the cloud" | a VM with the app installed by hand — no reproducible image, no rollback |
| 2 | **Nginx as the only public entry** | "low-latency streaming over unreliable networks" + the security requirements | publishing the API port — Nginx terminates TLS, adds the headers and hides the topology |
| 3 | **A separate `backend` network with `internal: true`** | "least privilege / do not expose the data" | one flat network — the database would be reachable from every container. Postgres publishes **no** port; the host backup/restore scripts run pg_dump/psql through `docker compose exec`. |
| 4 | **Redis for the rate-limit counters** | "reliable service" + a real security hole | the in-process counter: it resets on every restart and is not shared between replicas — a brute-force attack got `limit x instances` attempts |
| 5 | **Redis fails open to the local limiter** | "availability" | failing closed would take the whole API down when Redis hiccups; the degradation is reported in `/api/health` and in a metric instead |
| 6 | **Prometheus + Grafana + Alertmanager** | "monitoring and on-call" | a log-only setup — logs explain *what* happened, metrics tell you *that* something is wrong before a user does |
| 7 | **Telegram as the alert channel** | "what pages someone at 3 AM" | e-mail (spam folders, SMTP) or a pager service (an account, a contract) |
| 8 | **The alert rules are conservative** | "a false alarm at 3 AM is worse than a late detection" | alerting on every 5xx — one broken route would wake someone every night |
| 9 | **`pg_dump -Fc` + gzip + sha256 + S3** | "backups with a *tested* restore" | a `pg_dump` without a checksum (a silent corruption is discovered at the worst moment) |
| 10 | **A restore verification every week** | "prove the backup works" | a backup nobody ever restores — a hope, not a backup |
| 11 | **The API image is non-root and multi-stage** | "security" | the default `node` user with the compiler and the dev dependencies in the image |
| 12 | **The migrations run in a one-shot container, not at boot** | "the app must start, even when the migration fails" | migrating on every start — two replicas would race, and a failed migration would cause a crash loop |
| 13 | **The deployment rolls back automatically** | "reliability" | a manual rollback — at 3 AM nobody wants to SSH into a server |
| 14 | **Structured JSON logs with a request id** | "trace a user report through the logs" | pretty console logs — a log shipper cannot parse them |
| 15 | **`/api/metrics` is disabled by default** | "do not expose internals" | exposing the metrics endpoint publicly — it leaks the request rates and the error rates |
| 16 | **The SPA is served from the same origin** | "no CORS, no hardcoded hostnames" | a separate frontend host — then the SPA needs the API URL at build time and the browser needs CORS |
| 17 | **The monitoring ports are bound to `127.0.0.1`** | "never expose the monitoring publicly" | publishing Grafana on 0.0.0.0 — it would be the first thing an attacker finds |
| 18 | **A daily archive of the old rows to S3** | "data lifecycle — the part a data-infrastructure role actually owns" | deleting the rows (loses the history) or keeping them forever (the volume grows until the disk is full) |
| 19 | **Google Identity Services ID-token flow (no client secret)** | "Sign in with Google" without a secret in the deployment | the authorization-code flow — it needs a client secret in the environment and a redirect URI per origin; here the API verifies the signed ID token against Google's public keys |
| 20 | **A Google identity links to the account with the same verified email** | "one person, one account" | a second account per sign-in method — the person would lose their role, assets and bookings when they switch to Google |
| 21 | **TLS material lives in `infra/certs` and is bind-mounted** | "the certificate the host issues is the one Nginx serves" | a named volume (Docker Desktop/WSL cannot see the host path) and the host `/etc/letsencrypt` (invisible to the container) — both broke the first boot in practice |
| 22 | **The rate limiter counts per authenticated user, not per IP** (`UserThrottlerGuard`) | "a limit that protects people rather than a router" | the default IP tracker: an office behind one NAT shares 300 requests a minute, so one busy dashboard locks out its colleagues — and a load test from one machine can never exceed the ceiling, so it measures the limiter instead of the stack. The limit is unchanged (300/min); only the bucket is. An unverifiable token falls back to the IP, so a forged `sub` cannot mint a fresh bucket. |
| 23 | **The rebuild drill is two phases, with the S3 gate before the terminate** | "destroy a server and prove it comes back" | one script: it dies with the machine it is running on. The teardown records the launch configuration and `infra/.env` to the private bucket, verifies the newest dump's SHA-256 and refuses to continue without it; the rebuild runs from the laptop, re-associates the Elastic IP first (an unassociated address is billed and the link is dead), then provisions and restores. |
| 24 | **The load test ramps and samples, instead of one constant stage** | "find the breaking point, name the cause" | one 25-VU run: it cannot exceed 25 req/s by construction (one request a second each), so it measured the script — and it was taken before the limiter was enforced, which is why its 24.23 req/s must not be quoted as capacity. The driver walks 5 → 200 VUs, samples CPU/memory/Postgres once a second, stops at the first stage that breaks the thresholds and writes the table. |

| 25 | **The overlays became one internal kit (`Dialog`, `ConfirmDialog`, `Field`, `SearchDropdown`)** | "a modal a keyboard and a screen reader can use" | twelve hand-written `fixed inset-0` divs: none announced itself, Tab walked out of them, Escape did nothing and the focus was lost on close. A component library would have brought the same behaviour plus a theme to fight; four files of our own are the same behaviour, tested once, in the design the screens already use. |
| 26 | **The charts stay, but they are the last thing that loads** | "a dashboard without charts is a table" | one 1,089 kB bundle: a user who only wants to book a room downloaded Recharts, Framer Motion and eleven screens. The views load on demand and the two heavy libraries have their own cacheable chunks — 376 kB (120 kB gzipped) for the first screen, and the 412 kB of Recharts only when a chart is actually drawn. |
| 27 | **A 401 clears the session and returns the user to the page they were on** | "a session that expires should not look like a broken app" | showing the API's "Unauthorized" under every card: the user had no idea they had to sign in again. The redirect keeps `?next=` (validated to a local path, so it is not an open redirect). |
| 28 | **Polling through one hook with an in-flight guard and a visibility check** | "a live dashboard that does not lie" | five `setInterval`s: a slow response overlapped the next one (the older answer could win and the table jumped back), and a background tab kept polling a browser that throttles it. The hook skips a tick while a request is in flight, stops while the tab is hidden and refreshes the moment it is visible again. |
| 29 | **The raw API answers are typed as `ApiRecord` and read through `str`/`num`/`field`** | "a missing field must not become an empty cell" | `Record<string, any>`: a renamed field travelled to the screen as `undefined` and rendered as a blank column — the type checker approved. Now the shape is explicit, the helpers always return the right type, and `no-explicit-any` is a lint error. |
| 30 | **ESLint on the frontend, in CI, with the hooks rules on** | "the mistakes the type checker cannot see" | type check + tests only: a missing dependency in an effect (a stale label, a stale redirect) compiles and passes. The first run found 57 problems; 41 are fixed and 16 are reported as known advisories rather than hidden. |
| 31 | **State inside an effect is a warning, not an error** | "do not silence a rule, and do not refactor thirteen screens blind" | turning the rule off (it hides a real smell) or rewriting every data view in one change (it risks the whole app for a style preference). The warning count is the metric of the refactor to TanStack Query, and it is written down in `docs/ACCESSIBILITY.md`. |
| 32 | **The focus ring is never removed, and fields are 16 px on a phone** | "iOS zooms the page in on a small input and never zooms back out" | the design's `outline: none` (a keyboard user cannot see where they are) and 13-14 px fields in a form that a phone user has to pinch to use. |

## Things that were considered and are deliberately missing

| Idea | Why it is not there |
|------|---------------------|
| Kubernetes | One host, one workload. A cluster would be a second product to operate — and the interviewer would ask who maintains it. |
| Terraform / Ansible | The infrastructure is two Compose files and a short cloud guide. A student project that automates its own automation is harder to trust than one that is easy to read. |
| Redis for caching the reports | A second cache invalidation problem for a dashboard that answers in milliseconds. The rate limiter is the case where the shared state is genuinely needed. |
| A message queue | There is no asynchronous work in the application. A queue would be there to look impressive. |
| PgBouncer in front of Postgres | The connection count of one API container is far below the PostgreSQL limit. It matters when there are many replicas. |
| Prometheus in the app *and* a log shipper (Loki/ELK) | One observability stack is enough to demonstrate the discipline. |

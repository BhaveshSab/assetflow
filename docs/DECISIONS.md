# The decision log

Every component answers one requirement of the job. If a component does not
answer one, it is not in the stack.

| # | Decision | The requirement it serves | The alternative we rejected |
|---|----------|--------------------------|-----------------------------|
| 1 | **One host, containers** | "run the infrastructure on-site and in the cloud" | a VM with the app installed by hand — no reproducible image, no rollback |
| 2 | **Nginx as the only public entry** | "low-latency streaming over unreliable networks" + the security requirements | publishing the API port — Nginx terminates TLS, adds the headers and hides the topology |
| 3 | **A separate `backend` network with `internal: true`** | "least privilege / do not expose the data" | one flat network — the database would be reachable from every container |
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

## Things that were considered and are deliberately missing

| Idea | Why it is not there |
|------|---------------------|
| Kubernetes | One host, one workload. A cluster would be a second product to operate — and the interviewer would ask who maintains it. |
| Terraform / Ansible | The infrastructure is two Compose files and a short cloud guide. A student project that automates its own automation is harder to trust than one that is easy to read. |
| Redis for caching the reports | A second cache invalidation problem for a dashboard that answers in milliseconds. The rate limiter is the case where the shared state is genuinely needed. |
| A message queue | There is no asynchronous work in the application. A queue would be there to look impressive. |
| PgBouncer in front of Postgres | The connection count of one API container is far below the PostgreSQL limit. It matters when there are many replicas. |
| Prometheus in the app *and* a log shipper (Loki/ELK) | One observability stack is enough to demonstrate the discipline. |

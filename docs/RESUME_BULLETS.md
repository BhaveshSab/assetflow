# Resume bullets — the DevOps half

Every number below was measured on the live host, and the raw output is in
[`results/`](./results). If a claim is not in this file, it is not measured yet —
see **Do not claim** at the bottom.

## The five bullets

1. **Deployed the full stack on AWS EC2 (t3.micro) behind Nginx with Let's
   Encrypt TLS** — 9 Docker Compose services, multi-stage non-root images,
   PostgreSQL and Redis on an internal network with no published ports and
   monitoring bound to loopback only; modelled the run cost at **$12.04/month**
   instead of guessing it.

2. **Moved rate limiting and brute-force lockout out of process memory into
   Redis**, so the limits survive a restart and are shared across instances —
   the in-process counters reset on every deploy, which made the throttle
   bypassable; both paths fail open to a local counter and expose the
   degradation through `/health` and a Prometheus gauge.

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
   Actions runs lint, shellcheck, **212 tests** and both image builds, and the
   deploy job goes build → GHCR → SSH → migrate → health check with an
   **automatic rollback (48 s, measured on a forced failure)**.

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
frontend       26 passed,  3 files
               212 total
```

Use **212 automated checks: 72 unit, 114 e2e on embedded PostgreSQL (PGlite),
26 frontend.** The commands are `npm run test:unit`, `npm run test:e2e` and
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

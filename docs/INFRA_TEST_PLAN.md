# Infrastructure: what's tested, what isn't, and the shortest path to better

Reviewed against the repository at `main` @ `a7d08a5` plus this branch (`ee7c0e8`). Everything in §1 was checked in the code, not taken from the summary.

---

## 1. Your claims, verified in the repo

| Claim | Where | Verdict |
|---|---|---|
| Docker Compose stack behind Nginx | `infra/docker-compose.yml`, `infra/nginx/nginx.conf` | **True.** 11 runtime services: `api`, `postgres`, `redis`, `migrate`, `nginx`, `prometheus`, `alertmanager`, `grafana`, `node-exporter`, `postgres-exporter`, `cadvisor`, `blackbox-exporter` (plus a private `edge`/`backend` network split — not 9, and worth stating precisely) |
| Nothing but 80/443 published publicly | `docker-compose.yml` | **True.** Postgres/Redis have no `ports:`; Prometheus/Alertmanager/Grafana bind `127.0.0.1` only |
| Nightly `pg_dump` to encrypted S3 | `infra/scripts/backup.sh`, `systemd/assetflow-backup.timer` (02:30 daily) | **True, with a nuance.** The script does `pg_dump -Fc → sha256 → aws s3 cp`; the *encryption is the bucket's* (SSE-AES256, versioned, public access blocked, lifecycle to Glacier IR — `infra/README.md:123`). There is no client-side encryption, so "encrypted S3" is accurate but "encrypted backup" would overstate it |
| Restore verified | `infra/scripts/restore-verify.sh`, `systemd/assetflow-restore-verify.timer` (Sundays 03:00) | **True, and better than most.** Restores into a throwaway container, checks the SHA-256, compares row counts with live |
| Prometheus → Alertmanager → Telegram, alert rules | `infra/prometheus/prometheus.yml`, `infra/prometheus/rules/assetflow.yml` | **True.** 5 scrape jobs, **14** rules in 5 groups, and every rule has a `promtool test rules` case (`assetflow.test.yml`). The CV's "3 targets, 11 rules" is the older number |
| Grafana dashboard as code | `infra/grafana/dashboards/assetflow.json` + provisioning | **True** |
| Logs with request-id tracing | `backend/src/common/logging/json-logger.ts`, `request-context.middleware.ts`; `json-file` with `max-size 10m`, 3 files | **True** for app logs. They are *local* to the host — see §3.2 |
| CI: lint, shellcheck, tests | `.github/workflows/ci.yml` | **Runs** — but is **failing on main**, see §2 |
| Auto rollback | `infra/scripts/deploy.sh` (records the previous healthy image, health-checks `/api/health/ready`, rolls back) | **True** |
| Rate limiter re-keyed to the user | `backend/src/common/rate-limit/throttle-key.ts`, `user-throttler.guard.ts`, `auth-throttle.store.spec.ts` | **True** |
| "212 tests" | — | **Stale number.** Today: **163 backend e2e** (162 pass, 1 skipped) + **98 unit** + **95 frontend = 356 test cases**. Before this branch it was 155 + 98 + 95 = 348. Please don't quote 212 anywhere public |

---

## 2. Two things are broken right now (fix these before anything else)

**(a) CI is red on `main`.** Run `42404149752`, commit `a7d08a5`: the `Backend (lint, unit, e2e, build)` job fails at step **Lint**, and every later step (unit, e2e, build, bundle checks) is skipped. Cause: `backend/src/org/employees.service.ts` and `backend/src/reports/reports.service.ts` do not match Prettier, and CI runs `npm run lint -- --no-fix`. This branch fixes the formatting, so merging it turns CI green.

Consequence worth internalising: **for the whole of `a7d08a5`, no test has actually run in CI.** A green badge you never look at is worse than no badge. Add a branch-protection rule that requires the CI job, and a check that the job's *test* steps are not skipped.

**(b) Deploy fails at the SSH step.** Run `42404149685`: the image builds and pushes fine, then `Deploy` fails before the on-host health check. That is a reachability/credential problem (host address in repo secrets, security group, or the instance being stopped) — the old address `13.55.90.25` is dead and `3.107.83.86` was the live one. Nothing in the repo can fix this; the address and the SSH key need to be current.

Both of these matter more than any test in §3: an infrastructure you cannot deploy is not an infrastructure.

---

## 3. The tests that are still missing, by layer

Ordered by "would this catch a failure a user would notice?".

### 3.1 Alerting itself (highest value, ~1 hour)

You now have **14** rules, all of them unit-tested, and a script that triggers three of them by hand. What is still not tested is everything after the rule fires:

| Test | How | What it catches |
|---|---|---|
| Every rule fires | **Done.** `infra/prometheus/rules/assetflow.test.yml` — one firing case and one "healthy stack stays quiet" case per rule, run by the `Alerts (promtool)` job in `ci.yml` | A renamed metric or a typo'd `expr` that makes an alert *never* fire |
| Alerts reach Telegram | `infra/scripts/trigger-alerts.sh` exists — put it on a **weekly timer**, not a manual script | Alertmanager route/config drift after an edit |
| Alerts resolve | Same script, then assert the resolved notification arrives | Rules with no `for:`/`keep_firing_for` that flap |
| **The host dying is noticed** | External dead-man's switch (healthchecks.io / BetterStack free tier) pinging `https://<your-domain>/api/health` from outside | **Prometheus, Alertmanager and the app are all on the same t3.micro.** If the instance dies, the thing that would tell you dies with it. This is the single biggest gap in the whole setup |
| Certificate expiry | **Done.** `blackbox-exporter` scrapes `probe_ssl_earliest_cert_expiry`; `TlsCertificateExpiringSoon` fires below 3 days (not 14 — an IP certificate only lives ~6 days, so a longer threshold would be permanently on) | Let's Encrypt renewal failing quietly for weeks until browsers warn |

### 3.2 Observability coverage

- **Container metrics — done.** `cadvisor` scrapes `container_memory_working_set_bytes` / `container_spec_memory_limit_bytes`, `ContainerMemoryNearLimit` and `ApiRestarting` (`changes(process_start_time_seconds[1h]) > 1`) are in the rule file. Still missing: an alert on the *container* start-time series (`container_start_time_seconds`) for the case where the API is not scrapable at all — `ApiRestarting` needs the API to be up to notice it went down.
- **Logs are only on the host.** `json-file` with rotation is fine as a buffer, but a dead instance takes its evidence with it. Either ship the JSON logs off-box (Loki + Promtail, or CloudWatch via the Docker log driver) or accept explicitly that post-mortems will be blind.
- **No slow-query signal.** A `log_min_duration_statement = 200ms` in Postgres, or the Prisma middleware idea in `docs/BACKEND_SYSTEM_DESIGN_REVIEW.md` §7, catches the class of bug the code review found by reading (the unindexed `ActivityLog.createdAt`).

### 3.3 Failure drills (the ones that build real confidence)

Each is a 15-minute exercise with a written expected result. Run them monthly; keep the notes.

| Drill | Inject | Expected |
|---|---|---|
| Postgres dies mid-traffic | `docker compose stop postgres` under k6 load | 5xx for reads, `/api/health/ready` → `not-ready`, `PostgresDown` alert to Telegram, no data corruption, automatic recovery when restarted |
| Redis dies | `docker compose stop redis` | App keeps serving (memory fallback), `ThrottleStoreDegraded` fires, `/api/health` reports `rateLimitStore: memory` |
| Disk fills | `fallocate -l 900M /tmp/fill` (careful) | `HostDiskAlmostFull` → `HostDiskFull` escalate, writes fail cleanly rather than corrupting the DB |
| Migration fails | Add a deliberately broken migration on a scratch host | `migrate` service exits non-zero, **api is not started**, deploy rolls back |
| Host loss | Stop the instance, restore on a fresh one | `rebuild-drill.sh` from docs, RTO measured (you have 14 s for a restore — measure the *whole* rebuild, that is the number that matters) |
| Certificate expiry | Point DNS at a host with an expired cert | Users get a browser warning; your external probe should have told you days earlier |
| Deploy under load | k6 running while `deploy.sh` swaps the image | Count non-2xx during the swap. On Compose recreate you *will* see a short 502 window — measure it, then decide whether to care |

### 3.4 Data safety

- **Restore from S3, not just from the local dump.** `restore-verify.sh` verifies the newest *local* file. Add a monthly variant that downloads the newest object with `aws s3 cp` and restores *that* — this is the artifact that survives the instance dying.
- **Restore into a fresh host** once a quarter and run the smoke tests against it (`docs/results/restore-from-s3-*.txt` suggests you started this — finish it end to end).
- **Migration safety against real data.** Take the weekly restored copy, run `prisma migrate deploy` on it, and fail the job if it errors. This is how you find out that a new `NOT NULL` column breaks 40k existing rows — before production.
- Expand/contract discipline: add the nullable column, deploy, backfill, then make it required in a *later* release. Worth writing down once in `docs/DECISIONS.md`.

### 3.5 Performance

- **k6 in CI — done.** `.github/workflows/perf.yml` runs nightly at 03:15 UTC against a throwaway Postgres + Redis: migrations, the demo seed, a load-test fixture (one account per VU, so the run measures the API and not the 300/min limiter), then `k6 run` with `http_req_failed < 1%` and `p(95) < 800 ms` as *assertions* — a breach fails the workflow. The budgets are looser than production (1 s) because a shared runner is noisier. Results are uploaded as artifacts, not committed: a nightly commit to `docs/results/` would be 365 commits a year of machine noise.
- **Soak test:** 2 rps for an hour. Catches connection-pool leaks and the reminder-sweep timer accumulating work — neither shows up in a 30-second test.
- **`EXPLAIN (ANALYZE, BUFFERS)`** on the five heaviest queries, captured into `docs/results/` after each release. Cheap, and it is the artifact that proves an index did something.

### 3.6 Security

| Test | Tool | Why |
|---|---|---|
| Image vulnerabilities | `trivy image ghcr.io/...:sha` in CI (fail on HIGH) | Base image drift is invisible otherwise |
| Dependency vulnerabilities | `npm audit --production` (report), Dependabot (act) | Cheap continuously |
| Secret scanning | `gitleaks detect` on every push | A `.env` committed once is forever |
| TLS configuration | `testssl.sh` or `ssllabs-scan` quarterly, result committed | Proves the A grade you probably have |
| Header check | `curl -sI https://…/api/health` asserting HSTS/nosniff/frame-options in a test | Helmet config regressions |
| Rate limit **per user** | a test that two users behind the same IP do not share the 300/min budget, and that anonymous traffic still keys on IP | This is the bug you already found once; lock it with a test so it cannot come back |
| CORS | preflight `OPTIONS` from the SPA origin → 204 with the right headers; from a hostile origin → no `Access-Control-Allow-Origin` | Two past incidents (#16, #17) were exactly this |

### 3.7 Deploy pipeline

- **Smoke the image before switching traffic:** `docker run --rm <new-image> curl -f localhost:4000/api/health/ready` (or a `--wait` service) before `deploy.sh` recreates `api`. A broken image then costs zero downtime.
- **Assert the rollback in CI, not by hand:** force a failing health check on a scratch host and record the time to recovery (you quoted 48 s — keep that number honest with an automated job).
- **Reduce the 502 window:** either two `api` replicas with an nginx `upstream` and `docker compose up --scale api=2` (drain one at a time), or accept it and say so. On a t3.micro, two API replicas at ~120 MB each is affordable; Grafana/Prometheus are the memory hogs, not the API.

---

## 4. Ten improvements, in the order I would do them

| # | Change | Effort | Why it's first |
|---|---|---|---|
| 1 | Merge this branch → CI green again; add branch protection requiring it | 15 min | Right now nothing is gated |
| 2 | Fix the deploy SSH target (host address/secret) | 30 min | You cannot ship |
| 3 | External dead-man's switch on `/api/health` | 30 min | Your monitoring dies with the host |
| 4 | ~~`promtool test rules` for every alert~~ **done** — 14 rules, 28 cases, in CI | 2 h | 8 of 11 had never been proven |
| 5 | ~~cAdvisor + container restart/OOM alerts~~ **done** — `ContainerMemoryNearLimit`, `ApiRestarting` | 1 h | The likely failure mode on 1 GB |
| 6 | ~~Certificate-expiry alert~~ **done** — blackbox exporter, 3-day threshold | 30 min | Silent 30-day fuse |
| 7 | ~~Nightly k6 with thresholds~~ **done** — `.github/workflows/perf.yml`, artifacts | 3 h | Turns "it's fast" into a number |
| 8 | Restore-from-S3 monthly + migrate-against-restored-copy | 2 h | The backup you verify is the local one |
| 9 | trivy + gitleaks in CI | 1 h | Cheap, permanent |
| 10 | Ship logs off-box (Loki or CloudWatch) | 4 h | Post-mortems need evidence after the host is gone |

---

## 5. Cost and capacity reality check (t3.micro, $12.04/month)

- **1 GB of RAM, 2 vCPU.** 12 containers: Prometheus (~150-200 MB with 15 d retention), Grafana (~100 MB), Postgres (~80-150 MB), API (~120 MB), Redis (~10 MB), exporters (~30 MB each, plus cAdvisor ~40-80 MB and blackbox ~20 MB), Alertmanager (~20 MB), nginx (~10 MB). That is roughly 700-900 MB before page cache — you are close to the ceiling, and a k6 run or a Grafana query during a deploy is where it tips over. Add swap (2 GB, `vm.swappiness=10`) and/or move Grafana+Prometheus to a second t4g.nano later.
- **The architecture is right for the load.** One institution, ~2k assets, tens of requests per second: one host, one database, one API is the correct design, and the compose file's private networks are the right call. Do not "scale" this with Kubernetes; scale it by making the single host observable and replaceable — which is what `rebuild-drill.sh` is for.
- **$12.04/month is a good number to quote** because it is specific and defensible. Keep the line-item breakdown next to it (instance, EBS, S3, snapshot, egress) so the follow-up "how?" is answered before it is asked.

---

## 6. What to say about this in an interview

- "The deploy pipeline images the API, health-checks `/api/health/ready`, and rolls back to the last image that was actually healthy — I test the rollback path, not just the happy path."
- "Backups are `pg_dump -Fc` to a versioned, SSE-AES256 bucket with a 30-day lifecycle to Glacier; a weekly timer restores the newest dump into a throwaway container, checks the SHA-256 and compares row counts. The gap I am closing next is restoring the *S3 object*, not the local copy."
- "Alerts are code and the rules are unit-tested with `promtool`, so a renamed metric fails CI instead of silently deleting an alert."
- "Monitoring lived on the same host as the thing it monitored, which is a single point of failure — an external probe now covers host loss."
- "I found the rate limiter keyed everybody behind one NAT to 300 req/min and re-keyed it to the authenticated user; there is a regression test so it cannot come back."
- And the honest one: "CI was red on main for a day because of a Prettier failure that skipped every test step. That is why branch protection is now on — a pipeline that runs is not the same as a pipeline that gates."

# The resume claims and their evidence

> **Rule:** a claim goes on the resume only when the number below is filled
> in with a number *you measured*. A placeholder means the claim does not
> exist yet.
>
> The commands are the ones in this repository — an interviewer can run them
> too.

**The measured host:** AWS EC2 `t3.micro` in `ap-southeast-2` (Sydney), account
`459252806274`, instance tag `assetflow-s3-service`, Ubuntu, `3.107.83.86`,
reachable at <https://3.107.83.86.sslip.io> with a Let's Encrypt certificate
(issued 2026-10-28, expires 2027-01-26).

**The buckets:** `assetflow-backups-bhavesh-2026` (nightly dumps, ap-southeast-2)
and `assetflow-media-bhavesh-2026` (user media). Both private.

| # | The claim | The evidence | The measured value |
|---|-----------|-------------|--------------------|
| 1 | "The API, PostgreSQL and Redis run as containers behind Nginx with TLS" | `docker compose ps` · `curl -k https://<host>/api/health` | **9 containers healthy**; the API answers `{"status":"ok","database":"up","rateLimitStore":"redis","redis":"up"}`; TLS issuer `Let's Encrypt CN=YE1` |
| 2 | "The nightly backup is verified by restoring it — from the S3 copy, not just the local file" | [`docs/results/restore-from-s3-20261028T181200Z.txt`](./results/restore-from-s3-20261028T181200Z.txt) | **8 s** restoring the local dump, **14 s** re-downloading the object from S3 first (the RTO to quote for a rebuild); 44 KB dump; SHA-256 checked; 5 users / 3 departments / 5 assets compared row-by-row — every table equal to production |
| 3 | "The backup is nightly, 14-day rolling on the host, and lives in a private, versioned, lifecycle-managed S3 bucket" | [`docs/results/s3-backup-20261028T180510Z.txt`](./results/s3-backup-20261028T180510Z.txt) | **upload verified** — `assetflow-backups-bhavesh-2026` (ap-southeast-2), versioning `Enabled`, all four public-access blocks on, default SSE `AES256`, policy `DenyInsecureTransport`, lifecycle 30 d → `GLACIER_IR` / expire 365 d / noncurrent 30 d. Two objects, 43 KiB each, SHA-256 alongside |
| 4 | "Prometheus + Grafana with 11 alert rules and a Telegram delivery path that was tested on purpose" | [`docs/results/telegram-alert-20261028T181000Z.txt`](./results/telegram-alert-20261028T181000Z.txt) | **11 rules, 3/3 scrape targets up**, Alertmanager `ready`, dashboard provisioned; `trigger-alerts.sh all` produced `alertmanager_notifications_total{integration="telegram"} 3` with **zero failures** — three alerts delivered to `@AssetFlowAlertBot` |
| 5 | "The API answers with a JSON log line per request, including a request id" | `docker compose logs api \| tail -1` | observed: `{"ts":…,"level":"info","event":"http_request","requestId":"3e30c3f9-…","method":"GET","route":"/api/does-not-exist","status":404,"durationMs":0.7}` |
| 6 | "The rate-limit counters are shared through Redis and survive a restart" | `docker compose restart api` → the counter is still there | verified: `auth:throttle:nobody@example.com\|3.107.83.86` was still in Redis after the API container restarted |
| 7 | "CI runs lint, 62 unit tests, 114 e2e tests, 26 frontend tests, the builds and shellcheck" | the CI badge in the README | **202 checks** (62 + 114 + 26), all green locally on 2026-10-28; both container images build in CI |
| 8 | "The deployment over SSH rolls back automatically" | `IMAGE=… infra/scripts/deploy.sh` (with a failing health check) | **48 s** from start to a rolled-back, healthy container (pull → migrate → 3 failed health attempts → rollback) |
| 9 | "The load test" | [`docs/results/k6-20261028T143025Z.log`](./results/k6-20261028T143025Z.log) | **24.23 req/s at p95 35.4 ms**, 0.00 % failed, 4,392 requests, 25 VUs for 3 min; CPU peaked at 43.9 % (avg 21.5 %) |
| 10 | "The monthly cost" | [`docs/COSTS.md`](./COSTS.md) | **$12.04/month** of fixed list price (EC2 + EBS) + a few cents of S3 storage and requests |
| 11 | "Sign in with Google" | `curl https://<host>/api/auth/config` · the sign-in page | **verified end to end except the human click**: `/api/auth/config` serves the client id, Google Identity Services renders its button on `https://3.107.83.86.sslip.io/signin` with **no console error** (so the origin is authorised for the client), and `POST /api/auth/google` answers **401** for a forged ID token and **400** for a too-short one. A completed sign-in needs one click by the account owner |

## The commands that produce the evidence

```bash
# 1 + 5
docker compose ps
docker compose logs --tail 1 api

# 2
BACKUP_DIR=$HOME/backups infra/scripts/restore-verify.sh

# 3
aws s3 ls s3://$S3_BUCKET/$S3_PREFIX/ --human-readable
aws s3api get-bucket-versioning   --bucket $S3_BUCKET
aws s3api get-bucket-lifecycle-configuration --bucket $S3_BUCKET

# 4
infra/scripts/trigger-alerts.sh all
curl -s http://127.0.0.1:9093/metrics | grep alertmanager_notifications

# 6
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" KEYS 'auth:*'
docker compose restart api
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" KEYS 'auth:*'

# 8
IMAGE=busybox:1.36 HEALTH_URL=https://<host>/api/does-not-exist \
  HEALTH_RETRIES=3 infra/scripts/deploy.sh
# → the health check fails, the previous image is started again

# 9
k6 run infra/scripts/k6-load.js
```

## What is measured, and what is not

| Claim | Status |
|-------|--------|
| containers, TLS, health, JSON logs | measured on the EC2 host |
| backup → restore verification | measured (8 s local, 14 s from S3, 44 KB) |
| S3 upload, versioning, lifecycle | measured — 43 KiB object uploaded, versioning + public-access block + SSE + TLS-only policy + lifecycle all confirmed on the bucket ([evidence](./results/s3-backup-20261028T180510Z.txt)) |
| Prometheus rules firing | **11 rules loaded, 3/3 targets up**, all rules inactive on a healthy host ([evidence](./results/monitoring-20261028T163340Z.txt)); **Telegram delivery verified** — 3 notifications, 0 failures ([evidence](./results/telegram-alert-20261028T181000Z.txt)) |
| the nightly schedule | installed as a user crontab on the host (`backup.sh` 02:30 UTC, `restore-verify.sh` Sunday 03:00 UTC) — the systemd units in `infra/systemd/` are the alternative for a `/opt/assetflow` install |
| load test | measured (24.23 req/s, p95 35.4 ms, 0 % errors) |
| deployment rollback | measured (48 s) |
| the GitHub deploy workflow | **not run end to end** — it needs `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_PATH` variables and a `DEPLOY_SSH_KEY` secret; the GHCR packages are also private, so the host needs `docker login ghcr.io` (or a public package). The rollback path itself is measured (48 s) |
| the host-rebuild drill (terminate → relaunch → restore) | **not executed** — the `assetflow-s3-service` key is S3-only (`ec2:DescribeInstances` → `UnauthorizedOperation`), so the drill needs an IAM policy or the console; the step-by-step is in [REBUILD_DRILL](./REBUILD_DRILL.md) |
| sign in with Google | button renders on the live origin, the endpoint rejects bad tokens; the successful-account creation needs one human click |
| monthly cost | list price for EC2 + EBS, plus a few cents of S3 now that the dumps upload |

## The screenshots worth having

| Screenshot | Where it comes from |
|------------|--------------------|
| The Grafana dashboard with real traffic | `http://localhost:3001` (or an SSH tunnel to the server) after the load test |
| A Telegram message with a fired alert | `infra/scripts/trigger-alerts.sh backup` — the delivery itself is already proven by the counter in [the Telegram evidence](./results/telegram-alert-20261028T181000Z.txt) |
| The output of the restore verification | [`docs/results/`](./results) |
| `docker compose ps` with all the containers healthy | the terminal |
| The CI run (green) | the GitHub Actions tab |

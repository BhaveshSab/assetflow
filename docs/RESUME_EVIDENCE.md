# The resume claims and their evidence

> **Rule:** a claim goes on the resume only when the number below is filled
> in with a number *you measured*. A placeholder means the claim does not
> exist yet.
>
> The commands are the ones in this repository — an interviewer can run them
> too.

**The measured host:** AWS EC2 `t3.micro` in `ap-southeast-2` (Sydney),
Ubuntu, `3.107.83.86`, reachable at <https://3.107.83.86.sslip.io> with a
Let's Encrypt certificate (issued 2026-10-28, expires 2027-01-26).

| # | The claim | The evidence | The measured value |
|---|-----------|-------------|--------------------|
| 1 | "The API, PostgreSQL and Redis run as containers behind Nginx with TLS" | `docker compose ps` · `curl -k https://<host>/api/health` | **9 containers healthy**; the API answers `{"status":"ok","database":"up","rateLimitStore":"redis","redis":"up"}`; TLS issuer `Let's Encrypt CN=YE1` |
| 2 | "The nightly backup is verified by restoring it" | `infra/scripts/restore-verify.sh` | **9 s** from dump to verified restore (RTO); 43 KB dump; SHA-256 checked; 5 users / 3 departments / 5 assets compared row-by-row |
| 3 | "The backup is 14-day rolling and lives in a private, versioned S3 bucket" | `aws s3 ls s3://$S3_BUCKET/assetflow/backups/` | **bucket exists, upload not verified** — `assetflow-media-bhavesh-2026` (ap-southeast-2) answers `403` unsigned, so it is private and real; `backup.sh` reaches `PutObject` and AWS answers `InvalidAccessKeyId` because the pasted secret is 38 characters (AWS secrets are 40). The local dump + checksum + prune path is verified |
| 4 | "Prometheus + Grafana with N alert rules, tested on purpose" | `infra/scripts/trigger-alerts.sh` | **7 rules**; the test alert reached Alertmanager; **Telegram delivery is not verified** — the bot token is rejected by Telegram (`401 Unauthorized`) |
| 5 | "The API answers with a JSON log line per request, including a request id" | `docker compose logs api \| tail -1` | observed: `{"ts":…,"level":"info","event":"http_request","requestId":"3e30c3f9-…","method":"GET","route":"/api/does-not-exist","status":404,"durationMs":0.7}` |
| 6 | "The rate-limit counters are shared through Redis and survive a restart" | `docker compose restart api` → the counter is still there | verified: `auth:throttle:nobody@example.com\|3.107.83.86` was still in Redis after the API container restarted |
| 7 | "CI runs lint, 62 unit tests, 114 e2e tests, 26 frontend tests, the builds and shellcheck" | the CI badge in the README | **202 checks** (62 + 114 + 26), all green locally on 2026-10-28; both container images build in CI |
| 8 | "The deployment over SSH rolls back automatically" | `IMAGE=… infra/scripts/deploy.sh` (with a failing health check) | **48 s** from start to a rolled-back, healthy container (pull → migrate → 3 failed health attempts → rollback) |
| 9 | "The load test" | [`docs/results/k6-20261028T143025Z.log`](./results/k6-20261028T143025Z.log) | **24.23 req/s at p95 35.4 ms**, 0.00 % failed, 4,392 requests, 25 VUs for 3 min; CPU peaked at 43.9 % (avg 21.5 %) |
| 10 | "The monthly cost" | [`docs/COSTS.md`](./COSTS.md) | **$12.04/month** of fixed list price (EC2 + EBS) + a few cents of S3; the S3 part is not billed yet because no upload has succeeded |

## The commands that produce the evidence

```bash
# 1 + 5
docker compose ps
docker compose logs --tail 1 api

# 2
sudo -u assetflow infra/scripts/restore-verify.sh

# 3
aws s3 ls s3://$S3_BUCKET/assetflow/backups/ --human-readable
aws s3api get-bucket-lifecycle-configuration --bucket $S3_BUCKET

# 4
infra/scripts/trigger-alerts.sh all

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
| backup → restore verification | measured (9 s, 43 KB) |
| S3 upload, versioning, lifecycle | **not measured** — the bucket exists, the credential is rejected (`InvalidAccessKeyId`; the secret is 38 characters, AWS uses 40) |
| Prometheus rules firing | the rules evaluate and the test alert reaches Alertmanager; **Telegram delivery needs a valid bot token** |
| load test | measured (24.23 req/s, p95 35.4 ms, 0 % errors) |
| deployment rollback | measured (48 s) |
| the GitHub deploy workflow | **not run end to end** — it needs `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_PATH` variables and a `DEPLOY_SSH_KEY` secret; the GHCR packages are also private, so the host needs `docker login ghcr.io` (or a public package) |
| monthly cost | list price for EC2 + EBS; the S3 line is not billed because no upload has succeeded |

## The screenshots worth having

| Screenshot | Where it comes from |
|------------|--------------------|
| The Grafana dashboard with real traffic | `http://localhost:3001` (or an SSH tunnel to the server) after the load test |
| A Telegram message with a fired alert | `infra/scripts/trigger-alerts.sh backup` |
| The output of the restore verification | [`docs/results/`](./results) |
| `docker compose ps` with all the containers healthy | the terminal |
| The CI run (green) | the GitHub Actions tab |

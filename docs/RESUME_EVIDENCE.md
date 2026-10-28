# The resume claims and their evidence

> **Rule:** a claim goes on the resume only when the number below is filled
> in with a number *you measured*. A placeholder means the claim does not
> exist yet.
>
> The commands are the ones in this repository — an interviewer can run them
> too.

| # | The claim | The evidence | The value |
|---|-----------|-------------|----------|
| 1 | "The API, PostgreSQL and Redis run as containers behind Nginx with TLS" | `docker compose ps` · `curl -k https://<host>/api/health` | TBD |
| 2 | "The nightly backup is verified by restoring it" | `sudo -u assetflow infra/scripts/restore-verify.sh` | TBD seconds (RTO) |
| 3 | "The backup is 14-day rolling and lives in a private, versioned S3 bucket" | `aws s3 ls s3://$S3_BUCKET/assetflow/backups/` | TBD GB |
| 4 | "Prometheus + Grafana with N alert rules, tested on purpose" | `infra/scripts/trigger-alerts.sh` | 7 rules |
| 5 | "The API answers with a JSON log line per request, including a request id" | `docker compose logs api \| tail -1` | — |
| 6 | "The rate-limit counters are shared through Redis and survive a restart" | `docker compose restart api` → the counter is still there | — |
| 7 | "CI runs lint, 45 unit tests, 111 e2e tests, the build and shellcheck" | the CI badge in the README | 156 backend checks |
| 8 | "The deployment over SSH rolls back automatically" | `IMAGE=… infra/scripts/deploy.sh` (with a broken image) | TBD seconds |
| 9 | "The load test" | `docs/results/k6-*.json` | TBD req/s at p95 TBD ms |
| 10 | "The monthly cost" | `docs/COSTS.md` | TBD USD |

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
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" GET "throttle:default:1.2.3.4"
docker compose restart api
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" GET "throttle:default:1.2.3.4"

# 8
IMAGE=ghcr.io/bhaveshsab/assetflow-api:does-not-exist infra/scripts/deploy.sh
# → the health check fails, the previous image is started again

# 9
k6 run infra/scripts/k6-load.js
```

## The screenshots worth having

| Screenshot | Where it comes from |
|------------|--------------------|
| The Grafana dashboard with real traffic | `http://localhost:3001` after the load test |
| A Telegram message with a fired alert | `infra/scripts/trigger-alerts.sh backup` |
| The output of the restore verification | the terminal |
| `docker compose ps` with all the containers healthy | the terminal |
| The CI run (green) | the GitHub Actions tab |

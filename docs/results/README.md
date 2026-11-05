# The raw measurements

Terminal output, copied verbatim. A number in a document is a claim; the file
that produced it is the evidence.

**Host:** AWS EC2 `t3.micro`, `ap-southeast-2b` (Sydney), Ubuntu, 1 GB RAM,
30 GB gp3. Public entry point <https://3.107.83.86.sslip.io> (Let's Encrypt).
**Date:** 2026-10-28.

| File | What it is | The number that matters |
|------|------------|-------------------------|
| [`restore-from-s3-20261028T181200Z.txt`](./restore-from-s3-20261028T181200Z.txt) | `restore-verify.sh` after downloading the dump from S3 (the same drill also ran against the local dump) | **RTO 14 s** from S3 (**8 s** from the local dump); a **43 KiB** dump; every table equal to production |
| [`s3-backup-20261028T180510Z.txt`](./s3-backup-20261028T180510Z.txt) | `backup.sh` → S3, then the bucket's own configuration read back | two **43 KiB** objects; versioning, public-access block, SSE-AES256, TLS-only policy, lifecycle all confirmed |
| [`telegram-alert-20261028T181000Z.txt`](./telegram-alert-20261028T181000Z.txt) | `trigger-alerts.sh all` plus Alertmanager's notification counters | **3 Telegram notifications, 0 failures**, `getMe`/`getChat` both `ok:true` |
| [`monitoring-20261028T163340Z.txt`](./monitoring-20261028T163340Z.txt) | Prometheus targets + rules, Alertmanager status, Grafana provisioning, read from the host | **3/3 targets up, 11 rules loaded**, `AssetFlow — Overview` provisioned |
| [`rate-limit-20261105T083630Z.txt`](./rate-limit-20261105T083630Z.txt) | `THROTTLE_LIMIT=300 npm run test:e2e -- rate-limit` — the suite drives the real guard with the production limit | **300 x 200, then 429 on request #301** with `Retry-After: 60`; a second user behind the same IP is unaffected |

### Cited earlier, artifact not in this repository

`*.log` was ignored by `.gitignore` up to 2026-11-05, so four transcripts that
older documents link to were never committed. The measurements happened and the
numbers below are the ones that were recorded at the time — but the file a
reviewer would want to open is not here, so treat these as **unverified until
re-run** and re-run the command before quoting them:

| Missing file | What it recorded | The number | Re-generate with |
|--------------|------------------|-----------|------------------|
| `k6-20261028T143025Z.log` | `k6 run` — 25 VUs, 3 minutes, login then `GET /api/assets` | 4,392 requests, p95 35.4 ms, 0.00 % failed (24.23 req/s is the *script's* ceiling) | `infra/scripts/k6-test.sh`, or the `k6 run` line below |
| `restore-verify-20261028T144107Z.log` | `restore-verify.sh` against the local dump, with SHA-256 check | RTO 9 s, 43 KB dump, 5 users / 3 departments / 5 assets | `infra/scripts/restore-verify.sh <dump>` |
| `deploy-rollback-20261028T153000Z.log` | `deploy.sh` with a health check that cannot pass | 48 s to detect, roll back and start the previous image | `IMAGE=<old-tag> infra/scripts/deploy.sh` |
| `alert-test-20261028T144107Z.log`, `…T144122Z.log` | an **earlier** `trigger-alerts.sh` run, kept on purpose | the alert reached Alertmanager; Telegram answered `401` — that run used a bad token | `infra/scripts/trigger-alerts.sh all` |

## How the load test was run

```bash
k6 run -e BASE_URL=https://3.107.83.86.sslip.io \
       -e VUS=25 -e DURATION=3m infra/scripts/k6-load.js
```

The script makes one request per virtual user per second, so ~25 req/s is the
*offered* rate by construction. The result measures **latency under 25
concurrent users**, not the maximum throughput of the instance. CPU during the
run: max 43.9 %, avg 21.5 % (Prometheus).

## The honest gaps

- **The full host rebuild** (terminate the instance, launch a fresh one, restore
  from S3) has not been run. The S3 user cannot call `ec2:*`, and the drill
  destroys the server by design. The rehearsable half — download the object and
  restore it into a throwaway database — is measured above. The procedure is in
  [REBUILD_DRILL](../REBUILD_DRILL.md).
- **The GitHub deploy workflow** has not run end to end: it is skipped until
  `DEPLOY_HOST` is set as a repository variable, and the host needs a one-time
  `docker login ghcr.io` to pull the private image. The rollback inside
  `deploy.sh` *is* measured (48 s).
- **Sign in with Google** stops one human click short: the button renders on the
  live origin and the API rejects forged tokens, but no real Google account has
  completed the exchange yet.
- The load test measures **latency at 25 concurrent users**, not the throughput
  ceiling of the instance (see the note above).

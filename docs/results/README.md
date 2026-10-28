# The raw measurements

Terminal output, copied verbatim. A number in a document is a claim; the file
that produced it is the evidence.

**Host:** AWS EC2 `t3.micro`, `ap-southeast-2b` (Sydney), Ubuntu, 1 GB RAM,
30 GB gp3. Public entry point <https://3.107.83.86.sslip.io> (Let's Encrypt).
**Date:** 2026-10-28.

| File | What it is | The number that matters |
|------|------------|-------------------------|
| [`k6-20261028T143025Z.log`](./k6-20261028T143025Z.log) | `k6 run` — 25 VUs, 3 minutes, login then `GET /api/assets` | **4,392 requests, 24.23 req/s, p95 35.4 ms, 0.00 % failed, 100 % checks** |
| [`restore-verify-20261028T144107Z.log`](./restore-verify-20261028T144107Z.log) | `restore-verify.sh` — SHA-256 check, restore into a throwaway database, row-by-row comparison | **RTO 9 s**, 43 KB dump, 5 users / 3 departments / 5 assets |
| [`deploy-rollback-20261028T153000Z.log`](./deploy-rollback-20261028T153000Z.log) | `deploy.sh` with a health check that cannot pass | **48 s** to detect, roll back and start the previous image |
| [`alert-test-20261028T144107Z.log`](./alert-test-20261028T144107Z.log) · [`…T144122Z.log`](./alert-test-20261028T144122Z.log) | `trigger-alerts.sh` — the alert is injected into Alertmanager | the alert reached Alertmanager; **Telegram delivery failed: `telegram: Unauthorized (401)`** — the bot token was rejected |

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

- **No S3 upload has been measured.** The bucket
  `assetflow-media-bhavesh-2026` exists in ap-southeast-2 (it answers `403`
  unsigned, i.e. it is private and real), and `S3_BUCKET` now points at it, but
  AWS rejects the credential with `InvalidAccessKeyId`: the pasted secret is 38
  characters and AWS secret access keys are 40. The dump, the checksum and the
  14-day prune are verified; the upload is not.
- **No Telegram message has been received.** The token in `infra/.env` is
  rejected by the Bot API; the Alertmanager → Telegram chain is wired but
  unproven until a valid token is set.
- **The full host rebuild** (destroy the instance, restore from S3) has not
  been run — it needs the S3 bucket first.

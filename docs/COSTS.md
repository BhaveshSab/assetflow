# What the stack costs

> The point of this document is not the price — it is that **someone knows
> what the price is, and what happens when it grows.**
>
> The prices below are the on-demand list prices for **ap-southeast-2
> (Sydney)**, read on 2026-10-28. Your bill is the authority; this table is
> the model that predicts it.

## The formula

```
monthly cost = EC2 (instance + EBS) + S3 (storage + requests) + backups
             + monitoring (free) + data transfer

data transfer = (rows added per month x average row size) x 12
```

The only part that grows with the users is the database, the S3 archive and
the data transfer. Everything else is fixed.

## The current shape

| Item | Size | Unit price | Monthly | Note |
|------|------|-----------|---------|------|
| EC2 `t3.micro` | 730 h | $0.0132 / h | **$9.64** | the API + PostgreSQL + Redis + all five monitoring containers |
| EBS `gp3` | 30 GB | $0.08 / GB-month | **$2.40** | the database volume |
| S3 — backups | < 1 MB | $0.0245 / GB-month | **≈ $0.00** | 43 KiB dumps in `assetflow-backups-bhavesh-2026`, versioned, SSE-S3; older versions live 30 days, objects expire at 365 |
| S3 — archive | none yet | $0.0245 / GB-month | **$0.00** | the old rows move to Glacier after 30 days |
| S3 requests | ~30 PUT/month | $0.005 / 1 000 | **$0.00** | one `PutObject` per nightly backup |
| Data transfer | < 1 GB | first 100 GB free | **$0.00** | the S3 traffic inside the region is free |
| Monitoring | — | — | **$0.00** | Prometheus, Grafana, Alertmanager, two exporters — containers on the same host |
| **Total** | | | **$12.04 / month** | plus a few cents of S3 once the dumps accumulate |

> **Free tier:** a new account gets 750 h of `t3.micro` and 30 GB of EBS per
> month for 12 months. In that window the bill for this stack is **$0.00** —
> which is exactly why the budget alarm matters in month 13, not month 1.

## How the cost grows

| If … | then … |
|------|--------|
| the number of users grows 10× | the API cost does **not** grow (the measurement below shows 43.9 % CPU at 25 concurrent users) |
| the number of rows grows 10× | the storage grows 10×, the backup duration grows 10×, the S3 cost grows 10× |
| the archive is never pruned | the S3 bill grows forever — the archive is the classic "cloud bill surprise" |
| the log files are never rotated | the disk fills, the instance has to be enlarged, the bill grows |

## The measures that keep it small

1. **The archive has a lifecycle rule** — the rows older than 30 days move to
   Glacier (about a tenth of the price), the ones older than a year are
   deleted. The rule is in [AWS_SETUP](./AWS_SETUP.md).
2. **The logs rotate** — 10 MB × 3 files per container, `journald` is capped
   at 500 MB.
3. **The backups are pruned** — 14 days of dumps on the host, and a bucket
   lifecycle rule on the S3 side (30 days to Glacier Instant Retrieval, expired
   at 365, noncurrent versions deleted at 30). The rule does the pruning even if
   the host never wakes up again — which is exactly when you cannot run a
   cleanup script on it.
4. **One instance, sized by a measurement** — the load test decides whether a
   t3.micro is enough; it is not a guess.
5. **A budget alarm before anything else** — 50 %, 80 % and 100 % of the
   monthly budget, by e-mail. This is the first thing in
   [AWS_SETUP](./AWS_SETUP.md), because a bill that surprises you in month
   three is a bill you did not design for.

## The measured numbers (2026-10-28, `t3.micro`, ap-southeast-2)

| Measurement | Value | How |
|-------------|-------|-----|
| The p95 latency at 25 concurrent users | **35.4 ms** | [`results/k6-20261028T143025Z.log`](./results/k6-20261028T143025Z.log) |
| The failed requests in that run | **0.00 %** (0 of 4 392) | the same file |
| The requests per second it produced | **24.23** — the *script's* ceiling (25 VUs x one request a second), not the server's | the same file |
| The CPU during that run | **max 43.9 %, avg 21.5 %** of the host | Prometheus `node_cpu_seconds_total`, 14:30-14:34 Z |
| The memory in use | 67.3 % of 1 GB | Prometheus `node_memory_MemAvailable_bytes` |
| The size of the database after the seed | **8.4 MB** (`pg_database_size`) | `psql` in the Postgres container |
| The size of one backup | **43 KiB** | `ls -lh ~/backups/*.dump` |
| The duration of one backup | **0.93 s** | a timed `infra/scripts/backup.sh` run |
| The restore (RTO) | **8 s** local, **14 s** from S3 | [results/restore-from-s3-20261028T181200Z.txt](./results/restore-from-s3-20261028T181200Z.txt) |
| The requests per second the instance sustains | **TBD** | `infra/scripts/load-test.sh` — the staged ramp |
| The breaking point (stage, p95, errors) | **TBD** | the same report |
| The bottleneck behind it, with evidence | **TBD** | the per-second samples in the same report |
| The outage after losing the host (RTO) | **TBD** | `docs/results/rebuild-drill-<stamp>.md` |
| The recommended instance size | **t3.micro, provisionally** | it answered in 35 ms at 25 users and never left second gear, but the ramp that would justify a size has not been run |

> **What the first run does and does not say.** `k6-load.js` logs in once per
> virtual user and then requests the asset list once a second, so at 25 VUs the
> script can produce at most 25 req/s. 24.23 means the *script* was saturated,
> not the server: the run measured **latency under 25 concurrent users**
> (p95 35.4 ms, zero errors), which is a real number and a useful one — it is
> just not a capacity number.
>
> **And it predates the rate limiter.** The stack now answers `429` after 300
> requests a minute per client (measured on the host: 299 x 200, then 21 x 429),
> and the earlier run made 4 392 requests in three minutes with zero errors — it
> was taken on a build where the limiter was not yet enforced. So it cannot be
> compared with today's stack, and it must not be quoted as throughput.
>
> The staged ramp in `infra/scripts/load-test.sh` replaces it: it walks
> 5 -> 200 VUs, samples the host once a second, stops at the first stage that
> breaks the thresholds, and writes the table. **Until that report exists the
> capacity cells stay `TBD`** — a guessed req/s on a cost model is how a
> "sized by measurement" claim becomes a lie in an interview.

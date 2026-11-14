# What the stack costs

> The point of this document is not the price — it is that **someone knows
> what the price is, and what happens when it grows.**
>
> The prices below are the on-demand list prices for **ap-southeast-2
> (Sydney)**. Your bill is the authority; this table is the model that predicts
> it. See [Where these prices come from](#where-these-prices-come-from) for the
> source and query date of each figure — the table is *current* pricing, and the
> historical estimates from earlier measurements are kept separate and labelled.

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
| EBS `gp3` | 30 GB | $0.096 / GB-month | **$2.88** | the database volume |
| S3 — backups | < 1 MB | $0.0245 / GB-month | **≈ $0.00** | 43 KiB dumps in `assetflow-backups-bhavesh-2026`, versioned, SSE-S3; older versions live 30 days, objects expire at 365 |
| S3 — archive | none yet | $0.0245 / GB-month | **$0.00** | the old rows move to Glacier after 30 days |
| S3 requests | ~30 PUT/month | $0.005 / 1 000 | **$0.00** | one `PutObject` per nightly backup |
| Data transfer | < 1 GB | first 100 GB free | **$0.00** | the S3 traffic inside the region is free |
| Monitoring | — | — | **$0.00** | Prometheus, Grafana, Alertmanager, two exporters — containers on the same host |
| **Total** | | | **$12.52 / month** | plus a few cents of S3 once the dumps accumulate |

> **Free tier:** a new account gets 750 h of `t3.micro` and 30 GB of EBS per
> month for 12 months. In that window the bill for this stack is **$0.00** —
> which is exactly why the budget alarm matters in month 13, not month 1.

## Where these prices come from

Two different kinds of number live in this repository, and mixing them is how a
cost model drifts away from reality:

* **Current pricing** — the unit prices in the table above. These are queried
  from the AWS Price List API (`pricing:GetProducts`), not copied from memory.
* **Historical estimates** — figures recorded during earlier measurements or
  runs. These describe what a previous run *cost* or *was expected to cost*.
  They are evidence about the past, not a price you should reuse today.

### Verified unit prices

| Item | Price | Region filter | Source | Queried |
|------|-------|---------------|--------|---------|
| EC2 `t3.micro` | $0.0132 / h | Asia Pacific (Sydney) | AWS Price List API, service `AmazonEC2` | 2026-11-09 |
| EBS `gp3` storage | **$0.096 / GB-month** | Asia Pacific (Sydney) | AWS Price List API, service `AmazonEC2`, dimension `GB-Mo` | 2026-11-09 |
| EBS `gp3` IOPS | $0.006 / provisioned IOPS-month | Asia Pacific (Sydney) | AWS Price List API, service `AmazonEC2`, dimension `IOPS-Mo` | 2026-11-09 |
| Public IPv4 (in use) | $0.005 / h | Asia Pacific (Sydney) | AWS Price List API, service `AmazonVPC`, `APS2-PublicIPv4:InUseAddress` | 2026-11-09 |

> **Correction (2026-11-09).** This document previously listed `gp3` at
> **$0.08 / GB-month**. The verified Sydney list price is **$0.096 / GB-month**,
> so the old figure understated the volume cost by 20% — $2.40/month instead of
> $2.88/month. The total moved from $12.04 to $12.52. Anyone budgeting from the
> old number was budgeting about 4% low overall.

### How to re-verify

```bash
aws pricing get-products --service-code AmazonEC2 --region us-east-1   --filters "Type=TERM_MATCH,Field=volumeApiName,Value=gp3"             "Type=TERM_MATCH,Field=location,Value=Asia Pacific (Sydney)"   --query 'PriceList' --output json
# then read the dimension whose unit is GB-Mo (the IOPS-Mo dimension is a
# different price and reading the wrong one silently gives an unrelated figure)
```

The Price List API is a global endpoint in `us-east-1`; the *region* you are
pricing appears as a `location` filter, not as a request region.

### Historical estimates (do not reuse as current pricing)

| Estimate | Figure | Basis | Status |
|----------|--------|-------|--------|
| Isolated capacity run, 4 hours (t3.micro + 30 GB gp3 + public IPv4) | $0.0886 | verified unit prices × 4 h | HISTORICAL — a specific past plan, not the monthly cost |
| Same run, worst case with 30 min buffer | $0.0997 | verified unit prices × 4.5 h | HISTORICAL |
| Monthly cost before the gp3 correction | $12.04 | gp3 at $0.08 (unverified) | SUPERSEDED — retained to show what changed |

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
> requests a minute per authenticated user — measured, not assumed:
> `THROTTLE_LIMIT=300 npm run test:e2e -- rate-limit` issues 300 requests and
> gets 300 x `200`, then request **#301** is `429` with `Retry-After: 60`
> ([transcript](./results/rate-limit-20261105T083630Z.txt)). An earlier
> hand-written note claimed "299 x 200, then 21 x 429"; it was off by one and is
> superseded by that run. The earlier load test made 4 392 requests in three
> minutes with zero errors, so it was taken on a build where the limiter did not
> block at all (the throttler was configured with `blockDuration: 0`, which
> counts without ever refusing — fixed 2026-11-05, see `DECISIONS.md` row 33).
> It cannot be compared with today's stack, and it must not be quoted as
> throughput.
>
> The staged ramp in `infra/scripts/load-test.sh` replaces it: it walks
> 5 -> 200 VUs, samples the host once a second, stops at the first stage that
> breaks the thresholds, and writes the table. **Until that report exists the
> capacity cells stay `TBD`** — a guessed req/s on a cost model is how a
> "sized by measurement" claim becomes a lie in an interview.

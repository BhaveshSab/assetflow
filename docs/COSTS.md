# What the stack costs

> The point of this document is not the price — it is that **someone knows
> what the price is, and what happens when it grows.**
> Every number here is a placeholder until you fill it in from the AWS
> pricing calculator and from your own bill.

## The formula

```
monthly cost = EC2 (instance + EBS) + S3 (storage + requests) + backups
             + monitoring (free) + data transfer

data transfer = (rows added per month x average row size) x 12
```

The only part that grows with the users is the database, the S3 archive and
the data transfer. Everything else is fixed.

## The current shape (TBD — fill in the real prices)

| Item | Size | Unit price | Monthly | Note |
|------|------|-----------|---------|------|
| EC2 (t3.micro / t3.small) | 1 | TBD | TBD | the API + PostgreSQL + Redis + the monitoring |
| EBS gp3 | 30 GB | TBD | TBD | the database volume |
| S3 — backups | TBD GB | TBD | TBD | 14 days of dumps |
| S3 — archive | TBD GB | TBD | TBD | the old rows, moved to Glacier after 30 days |
| S3 requests | TBD | TBD | TBD | the nightly `PutObject` |
| Data transfer | TBD GB | TBD | TBD | only the responses, not the backups (the S3 traffic is free inside the region) |
| **Total** | | | **TBD** | |

## How the cost grows

| If … | then … |
|------|--------|
| the number of users grows 10× | the API cost does **not** grow (the same instance handles it until the CPU is saturated) |
| the number of rows grows 10× | the storage grows 10×, the backup duration grows 10×, the S3 cost grows 10× |
| the archive is never pruned | the S3 bill grows forever — the archive is the classic "cloud bill surprise" |
| the log files are never rotated | the disk fills, the instance has to be enlarged, the bill grows |

## The measures that keep it small

1. **The archive has a lifecycle rule** — the rows older than 30 days move to
   Glacier (about a tenth of the price), the ones older than a year are
   deleted. The rule is in [AWS_SETUP](./AWS_SETUP.md).
2. **The logs rotate** — 10 MB × 3 files per container, `journald` is capped
   at 500 MB.
3. **The backups are pruned** — 14 days locally *and* in S3.
4. **One instance, sized by a measurement** — the load test decides whether a
   t3.micro is enough; it is not a guess.
5. **A budget alarm before anything else** — 50 %, 80 % and 100 % of the
   monthly budget, by e-mail. This is the first thing in
   [AWS_SETUP](./AWS_SETUP.md), because a bill that surprises you in month
   three is a bill you did not design for.

## The measured numbers (fill in)

| Measurement | Value | How |
|-------------|-------|-----|
| The p95 latency under load | TBD | `docs/results/k6-*.json` |
| The requests per second the instance sustains | TBD | the same file |
| The size of the database after the seed | TBD | `pg_database_size` |
| The size of one backup | TBD | `ls -lh /var/backups/assetflow/` |
| The recommended instance size | TBD | derived from the p95 above |

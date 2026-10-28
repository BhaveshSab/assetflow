# The disaster-recovery drill

> A backup you have never restored is a hope, not a backup.
> This document is the script of the drill — run it end to end, write the real
> numbers into the table at the bottom, and you have the most valuable slide
> in your portfolio.

## The objectives

| | |
|---|---|
| **RPO** (recovery *point* objective) | how much data may be lost → the age of the newest backup |
| **RTO** (recovery *time* objective) | how long may the service be down → the duration of the restore |
| **Drill frequency** | once a month, on a copy of the production data |

## The drill (about 30 minutes)

```bash
# 0. Write down what you expect — then compare it with the result.
date +%s > /tmp/drill-start

# 1. Prove the backup exists and is recent
ls -lh ~/backups/
sha256sum ~/backups/assetflow-*.dump | tail -1
aws s3 ls "s3://$S3_BUCKET/$S3_PREFIX/" --human-readable | tail -2

# 2. Break the database — this is the "disaster"
docker compose stop postgres
#    …the API now answers 500 on every route that touches the data

# 3. Restore the newest dump into a throwaway database and verify it
BACKUP_DIR=$HOME/backups infra/scripts/restore-verify.sh
#    → it prints the duration, the row counts and "the backup can be restored"
#
# The stronger version downloads the object first, so the S3 copy is what
# gets restored:
aws s3 cp "s3://$S3_BUCKET/$S3_PREFIX/" /tmp/s3-restore/ --recursive \
  --exclude '*' --include '*.dump' --include '*.sha256'
BACKUP_DIR=/tmp/s3-restore infra/scripts/restore-verify.sh

# 4. Restore for real
docker compose up -d postgres
docker compose exec -T postgres psql -U assetflow -d assetflow < /dev/null
docker compose run --rm migrate          # the schema is back
#    …and the data: restore the dump into the live database
docker compose exec -T postgres pg_restore -U assetflow -d assetflow --clean --if-exists \
  < <(docker compose exec -T postgres pg_dump -U assetflow -d assetflow --schema-only)

# 5. Confirm that the service works again
curl -fsS http://127.0.0.1/api/health/ready
docker compose logs --tail 20 api

# 6. Measure
date +%s > /tmp/drill-end
echo "the drill took $(( $(cat /tmp/drill-end) - $(cat /tmp/drill-start) )) seconds"
```

> Step 4 is the dangerous one — it overwrites the live database. Do it **only**
> on a copy or in the staging environment, never on the production data.

## The scenario 2: the whole host is gone

This is the case the S3 backup really exists for. The full terminate-relaunch
sequence, with the IAM permissions it needs and the exact timings to record, is
in [REBUILD_DRILL](./REBUILD_DRILL.md).

```bash
# on a *new* server
sudo infra/scripts/harden-server.sh
cp infra/.env.example infra/.env && $EDITOR infra/.env    # the same secrets
sudo infra/scripts/issue-cert.sh --self-signed             # bootstrap
# (restore the data first — the certificate can be re-issued later)
docker compose -f infra/docker-compose.yml up -d --build
docker compose run --rm migrate

# the newest backup is fetched from S3
mkdir -p ~/backups
aws s3 cp "s3://$S3_BUCKET/$S3_PREFIX/" ~/backups/ --recursive
BACKUP_DIR=$HOME/backups infra/scripts/restore-verify.sh
```

## The results (measured 2026-10-28, `t3.micro`, ap-southeast-2)

| Measurement | Value | How it was measured |
|-------------|-------|---------------------|
| The size of one backup | **43 KiB** (44 K on disk) | `ls -lh ~/backups/assetflow-20261028T180510Z.dump` |
| Where it lands | `s3://assetflow-backups-bhavesh-2026/assetflow/backups/` | `aws s3 ls` — versioned, SSE-AES256, lifecycle 30 d → Glacier IR / 365 d expire |
| The duration of the backup | **0.93 s** | a timed `infra/scripts/backup.sh` run (`pg_dump` + SHA-256 + prune) |
| The duration of the restore (RTO) | **8 s** locally, **14 s** when the dump is re-downloaded from S3 first | [`results/restore-from-s3-20261028T181200Z.txt`](./results/restore-from-s3-20261028T181200Z.txt) |
| The age of the newest backup (RPO) | **52 s** during the drill; **≤ 24 h** in production (the 02:30 timer) | the dump timestamp vs. the restore timestamp |
| The rows restored | **5 users, 3 departments, 5 assets**, 0 allocations/notifications/activity rows — every table equal to production | the output of `restore-verify.sh`, which compares every table with the live database |
| The time a full host rebuild takes | **not measured yet** — the drill destroys the instance, so it needs an IAM policy the current key does not have; see [REBUILD_DRILL](./REBUILD_DRILL.md) | the steps there, timed end to end |

> The drill restored a **43 KiB dump in 8 seconds** — 14 seconds when the dump
> had to come back from S3 first — and compared every table against production
> before declaring it good. The honest limit: this is a logical dump of a small
> seeded database, so the RTO scales with the dump, not with the disk — measure
> it again when the data grows.

> Copy the real output into `docs/results/` — a screenshot of the terminal is
> worth more than a number you typed into a document.

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
ls -lh /var/backups/assetflow/
sha256sum /var/backups/assetflow/assetflow-*.dump | tail -1

# 2. Break the database — this is the "disaster"
docker compose stop postgres
#    …the API now answers 500 on every route that touches the data

# 3. Restore the newest dump into a throwaway database and verify it
sudo -u assetflow infra/scripts/restore-verify.sh
#    → it prints the duration, the row counts and "the backup can be restored"

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

This is the case the S3 backup really exists for.

```bash
# on a *new* server
sudo infra/scripts/harden-server.sh
cp infra/.env.example infra/.env && $EDITOR infra/.env    # the same secrets
sudo infra/scripts/issue-cert.sh --self-signed             # bootstrap
# (restore the data first — the certificate can be re-issued later)
docker compose -f infra/docker-compose.yml up -d --build
docker compose run --rm migrate

# the newest backup is fetched from S3
aws s3 cp "s3://$S3_BUCKET/assetflow/backups/" /var/backups/assetflow/ --recursive
sudo -u assetflow infra/scripts/restore-verify.sh
```

## The results (measured 2026-10-28, `t3.micro`, ap-southeast-2)

| Measurement | Value | How it was measured |
|-------------|-------|---------------------|
| The size of one backup | **43 KB** | `ls -lh ~/backups/assetflow-20261028T144015Z.dump` |
| The duration of the backup | **0.93 s** | a timed `infra/scripts/backup.sh` run (`pg_dump` + SHA-256 + prune) |
| The duration of the restore (RTO) | **9 s** | [`results/restore-verify-20261028T144107Z.log`](./results/restore-verify-20261028T144107Z.log) |
| The age of the newest backup (RPO) | **52 s** during the drill; **≤ 24 h** in production (the 02:30 timer) | the dump timestamp vs. the restore timestamp |
| The rows restored | **5 users, 3 departments, 5 assets**, 0 allocations/notifications/activity rows | the output of `restore-verify.sh`, which compares every table with the live database |
| The time a full host rebuild takes | **not measured yet** — the drill destroys the instance, so it is scheduled as its own exercise | the steps above, timed end to end |

> The drill restored a **43 KB dump into a throwaway database in 9 seconds**
> and compared every table against production before declaring it good. The
> honest limit: this is a logical dump of a small seeded database, so the RTO
> scales with the dump, not with the disk — measure it again when the data
> grows.

> Copy the real output into `docs/results/` — a screenshot of the terminal is
> worth more than a number you typed into a document.

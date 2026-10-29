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

## Scenario 3 — the whole host is gone (the EC2 rebuild drill)

Scenarios 1 and 2 restore a **database**. This one restores a **server**: the
instance is terminated, a new one is launched from the configuration that was
recorded first, the Elastic IP is re-attached (so the hostname never changes),
and the data comes back from S3.

It runs in **two phases**, because a script cannot survive the machine it is
running on.

### Phase 1 — teardown (on the old server)

```bash
sudo infra/scripts/rebuild-drill.sh --phase teardown --allow-instance-id i-0123456789abcdef0
```

1. **The safety gate.** It reads the newest `.dump` and `.sha256` from
   `s3://$S3_BUCKET/assetflow/backups/`, refuses a dump older than 26 hours,
   **downloads it and verifies the SHA-256**, and aborts without changing
   anything if any of that fails. There is no flag to skip it: an instance
   whose data is not verifiably in S3 is not a drill, it is an outage.
2. **The recording.** `instance.json` — image id, instance type, subnet,
   security groups, key pair, IAM profile, availability zone, the root volume,
   the user data (decoded) and the Elastic IP allocation id — plus a copy of
   `infra/.env`, both uploaded to `s3://$S3_BUCKET/assetflow/drill/<stamp>/`.
   The configuration never comes from a wiki page; it comes from the machine
   that is about to disappear.
3. **The clock starts** at the `terminate-instances` call and the instance is
   waited on until it is `terminated`.

> The `infra/.env` is the trap of every rebuild: it is git-ignored, so a new
> instance comes back without the database password, the JWT secret or the bot
> token. That is why it is copied to the private bucket *before* the teardown.

### Phase 2 — rebuild (on your laptop, **not** on the instance)

```bash
infra/scripts/rebuild-drill.sh --phase rebuild --run <stamp> --ssh-key ~/.ssh/assetflow-key.pem
```

1. `run-instances` with the recorded configuration and recorded user data;
2. **immediately** `associate-address` — an unassociated Elastic IP is billed,
   and a portfolio link pointing at a dead address is worse than the cost;
3. wait for `running`, then for the public IP to be **the same address**;
4. wait for SSH (a fresh instance needs ~30 s for cloud-init);
5. `provision-host.sh` over SSH — Docker, the repository, `infra/.env` from S3
   (mode 0600), hardening, the certificate, the stack, the migrations, the
   health check, the systemd timers;
6. download the dump from S3, check the SHA-256, restore into a throwaway
   container first, then the live restore, then restart the API;
7. wait for `GET /api/health/ready` — **that is when the clock stops**.

### Phase 3 — the report

```bash
infra/scripts/rebuild-drill.sh --phase report --run <stamp>
```

It writes `docs/results/rebuild-drill-<stamp>.md`: the timeline, the RTO, the
RPO, the address, and the duration of each provisioning step.

### The rules (they protect real data and real money)

| Rule | Why |
|---|---|
| The S3 gate is not optional | a termination is irreversible; the backup is the only copy |
| One instance at a time | the Elastic IP attaches to one; a second t3.micro would be pointless |
| Re-associate the address first | it is billed while unassociated, and the site is down either way |
| Never delete the bucket, the policy, the role or the group | the drill replaces an *instance*, nothing else |
| The drill is destructive | do not run it on a box whose data is not verifiably in S3 |

### The results

| Measurement | Value | How it was measured |
|---|---|---|
| The outage (RTO) | **TBD** | `t_healthy − t_terminate` in `timeline.txt` |
| The RPO | **TBD** | the age of the newest dump at the terminate call |
| The instance was running again | **TBD** | `t_running − t_terminate` |
| SSH answered | **TBD** | `t_ssh − t_running` |
| The host was provisioned | **TBD** | `t_provisioned − t_ssh` (see `provision.log`) |
| The data was restored | **TBD** | `t_restored − t_provisioned` |
| The API was ready with the restored data | **TBD** | `t_healthy − t_restored` |
| The address | `3.107.83.86` before and after | the two `describe-instances` calls |

> Every cell stays `TBD` until the drill has actually run. Filling one in
> from an estimate would defeat the point of doing the drill.

## The results (measured 2026-10-28, `t3.micro`, ap-southeast-2)

| Measurement | Value | How it was measured |
|-------------|-------|---------------------|
| The size of one backup | **43 KiB** (44 K on disk) | `ls -lh ~/backups/assetflow-20261028T180510Z.dump` |
| Where it lands | `s3://assetflow-backups-bhavesh-2026/assetflow/backups/` | `aws s3 ls` — versioned, SSE-AES256, lifecycle 30 d → Glacier IR / 365 d expire |
| The duration of the backup | **0.93 s** | a timed `infra/scripts/backup.sh` run (`pg_dump` + SHA-256 + prune) |
| The duration of the restore (RTO) | **8 s** locally, **14 s** when the dump is re-downloaded from S3 first | [`results/restore-from-s3-20261028T181200Z.txt`](./results/restore-from-s3-20261028T181200Z.txt) |
| The age of the newest backup (RPO) | **52 s** during the drill; **≤ 24 h** in production (the 02:30 timer) | the dump timestamp vs. the restore timestamp |
| The rows restored | **5 users, 3 departments, 5 assets**, 0 allocations/notifications/activity rows — every table equal to production | the output of `restore-verify.sh`, which compares every table with the live database |
| The time a full host rebuild takes | **TBD** — the drill is scripted and the Elastic IP is in place, but it has not been run yet; see scenario 3 above | `infra/scripts/rebuild-drill.sh` writes the timeline and the RTO |

> The drill restored a **43 KiB dump in 8 seconds** — 14 seconds when the dump
> had to come back from S3 first — and compared every table against production
> before declaring it good. The honest limit: this is a logical dump of a small
> seeded database, so the RTO scales with the dump, not with the disk — measure
> it again when the data grows.

> Copy the real output into `docs/results/` — a screenshot of the terminal is
> worth more than a number you typed into a document.

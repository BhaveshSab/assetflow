# The runbook

> What you do **when something is broken at 2 AM**.
> Every command below was run on this stack — copy/paste them.
>
> The three questions that come first:
> 1. **Is the user affected?** `curl -fsS https://<host>/api/health/ready`
> 2. **What changed?** `docker compose ps` · `docker compose logs --tail 100 api`
> 3. **Is it the host or the app?** `df -h` · `free -h` · `uptime`

---

## API down {#api-down}

**Symptom:** the site shows an error, or `/api/health` answers 503.

```bash
cd /opt/assetflow

docker compose ps                       # is the container running?
docker compose logs --tail 100 api      # what does it say?
curl -fsS http://127.0.0.1/api/health/ready && echo "the API is fine"
```

| The log says | The cause | The fix |
|--------------|-----------|---------|
| `could not start: … not configured correctly` | an environment variable is missing | `grep -E '^[A-Z_]+=' infra/.env` — compare it with `infra/.env.example` |
| `relation "User" does not exist` | the migrations were not applied | `docker compose run --rm migrate` |
| `Could not reach the database` | Postgres is down | see [database down](#database-down) |
| `EADDRINUSE` | something else owns port 4000 | `docker compose down && docker compose up -d api` |
| nothing — the container is `Restarting` | the process crashes at boot | `docker compose logs --tail 200 api` |

**Restart it properly** (the deployment script does exactly this, with a
rollback):

```bash
IMAGE=ghcr.io/bhaveshsab/assetflow-api:latest infra/scripts/deploy.sh
```

---

## Many 5xx errors {#many-5xx-errors}

```bash
docker compose logs --tail 200 api | grep -E '"status":5'
curl -sS http://127.0.0.1:9090/api/v1/query \
  --data-urlencode 'query=sum(rate(assetflow_http_requests_total{status=~"5.."}[5m]))' \
  | head -20
```

The usual causes, in the order they happen:

1. **The database is gone or full** → `df -h` and `docker compose ps postgres`.
2. **A migration is missing** → the log says `relation "…" does not exist`.
3. **The connection pool is exhausted** → `docker compose exec postgres psql -U assetflow -d assetflow -c "SELECT count(*) FROM pg_stat_activity;"`.
4. **Redis is down** → the API logs `Redis is unavailable` — it keeps serving
   (the limiter falls back to the local counter), so this is *not* a 5xx
   cause, but it is worth fixing.

---

## Database down {#database-down}

```bash
docker compose ps postgres
docker compose logs --tail 100 postgres
docker compose restart postgres
```

If the **volume** is broken (the container starts and immediately exits):

```bash
docker compose stop postgres
ls -lah /var/lib/docker/volumes/ | grep pgdata   # is the data there?
docker compose up -d postgres
```

If the data is really gone, restore the last backup — see
[the DR drill](./DR_DRILL.md).

---

## Disk full {#disk-full}

```bash
df -h                                   # how full is it?
docker system df                        # how much do the images use?
du -xh --max-depth=1 /var/lib/docker | sort -h | tail
journalctl --disk-usage                 # the logs?
```

**The usual suspects, in this order:**

```bash
# 1. the Docker images and the stopped containers
docker image prune -a --filter "until=168h"
docker container prune --filter "until=168h"

# 2. the container logs
docker compose logs --tail 20 api
truncate -s 0 /var/lib/docker/containers/*/*-json.log

# 3. the old backups
ls -lh /var/backups/assetflow/
find /var/backups/assetflow -name 'assetflow-*.dump*' -mtime +14 -delete

# 4. the archive files that were exported but not uploaded
ls -lh /var/backups/assetflow/archive/
```

**Prevent it:** the log rotation is part of the Compose file (10 MB × 3 per
container), `journald` is limited to 500 MB, and the backup retention deletes
the dumps after 14 days.

---

## The backup failed {#backup-failed}

```bash
systemctl status assetflow-backup.timer
systemctl list-timers | grep assetflow
journalctl -u assetflow-backup.service -n 100 --no-pager
sudo -u assetflow /opt/assetflow/infra/scripts/backup.sh --dry-run
```

The most common causes:

| The message | The cause | The fix |
|-------------|-----------|---------|
| `the AWS CLI is not installed` | the CLI is missing on the server | `apt install awscli` (or use the instance role — see [AWS_SETUP](./AWS_SETUP.md)) |
| `AccessDenied` | the IAM role lacks `s3:PutObject` | fix the role (least privilege: only the backup prefix) |
| `could not connect to the server` | the database was not reachable | check `docker compose ps postgres` |
| `No space left on device` | the disk is full | see [disk full](#disk-full) |

**Run it by hand** (the same way the timer does):

```bash
sudo -u assetflow /opt/assetflow/infra/scripts/backup.sh
```

> **On the current host** the checkout is `/home/ubuntu/assetflow` and the dumps
> live in `/home/ubuntu/backups` (`BACKUP_DIR` in `infra/.env`) — not the
> `/opt/assetflow` layout the systemd units assume. The schedule there is a user
> crontab that runs the same scripts:
>
> ```bash
> crontab -l
> # 30 2 * * * cd /home/ubuntu/assetflow && ./infra/scripts/backup.sh >> /home/ubuntu/backups/backup-cron.log 2>&1
> # 0 3 * * 0 cd /home/ubuntu/assetflow && ./infra/scripts/restore-verify.sh >> /home/ubuntu/backups/restore-cron.log 2>&1
> ```
>
> The scripts source `infra/.env` themselves, so cron needs no environment.

---

## Sign in with Google is unavailable

The page reads the configuration from the API, so the first check is public:

```bash
curl -fsS https://<host>/api/auth/config
# {"googleClientId":null}  → GOOGLE_CLIENT_ID is not set in the API environment
# {"googleClientId":"…"}   → configured; the problem is the page origin
```

* The button is disabled → set `GOOGLE_CLIENT_ID` in `infra/.env`, then
  `docker compose up -d api`.
* The popup says the origin is not allowed → add the exact origin
  (`https://<host>`, no path) under **Authorized JavaScript origins** in the
  Google Cloud OAuth client.
* `503 Google sign-in is not configured` → same as the null case.
* `401 Google sign-in failed` → the token was expired, malformed or issued for
  another client id; retry from the page. The API deliberately does not echo
  the verification error.

## Renew the TLS certificate

```bash
cd /opt/assetflow
sudo certbot renew --config-dir infra/certs --webroot -w infra/certbot-www
docker compose -f infra/docker-compose.yml exec nginx nginx -s reload
openssl x509 -enddate -noout -in infra/certs/live/assetflow/fullchain.pem
```

## The alerts do not arrive

```bash
docker compose logs --tail 50 alertmanager
curl -sS http://127.0.0.1:9093/api/v2/status | head -30
```

* Is the rule firing? → `http://127.0.0.1:9090/alerts` (through the tunnel).
* Is Alertmanager sending it? → the `alertmanager` log shows the delivery.
* Is the Telegram token right? → `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
  in `infra/.env`, then `docker compose up -d alertmanager` (the config is a
  template — it is rendered at start).

**Test the whole chain:**

```bash
cd /opt/assetflow
infra/scripts/trigger-alerts.sh backup     # pretends the backup is 3 days old
```

---

## A deploy went wrong

```bash
# what is running?
docker compose ps
docker compose images

# the deployment script keeps the previous image
cat ~/.local/state/assetflow/previous-image

# roll back
IMAGE=$(cat ~/.local/state/assetflow/previous-image) infra/scripts/deploy.sh
```

The deployment script does this automatically when the health check fails —
but knowing how to do it by hand is the point of the runbook.

---

## Getting the monitoring tools

They are bound to `127.0.0.1` on purpose. From your laptop:

```bash
ssh -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 user@server
```

Then open <http://localhost:3001> (Grafana), <http://localhost:9090>
(Prometheus) and <http://localhost:9093> (Alertmanager).

---

## The commands worth knowing by heart

```bash
# what is running?
docker compose ps

# the last 100 log lines of a service
docker compose logs --tail 100 api

# follow the logs
docker compose logs -f api

# into a container
docker compose exec api sh

# what is using the disk?
df -h && du -xh --max-depth=1 / | sort -h | tail

# what is eating the CPU?
top && docker stats --no-stream

# is the port free?
ss -ltnp | grep 4000

# what did the server do in the last hour?
journalctl --since "1 hour ago" --no-pager | tail -50

# the timers (the backups)
systemctl list-timers --all | grep assetflow
```

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

## The API answers 500 on every request {#api-500-every-request}

**Symptom:** every call — `/api/health` included — returns `500 Internal Server
Error`, and the browser console shows a **CORS** error ("No
`Access-Control-Allow-Origin` header"). The CORS message is a red herring.

**How to tell the two apart.** The CORS headers are written by the application
as soon as it starts. So:

- **500 (or 503) *with* the header** → the app started, the route failed.
- **500 with *no* header at all** → the app never started. Nothing the browser
  says about CORS is true; the server died while loading.

```bash
curl -i https://API/api/health | head -20      # status and headers, side by side
ls backend/dist                               # what did the build actually emit?
```

**The cause we hit on 2026-11-07.** `nest build` compiles everything that is
not excluded in `tsconfig.build.json`. While it compiled only `src/`, the output
was `dist/main.js` and `dist/serverless.js`. Adding `scripts/promote.ts` to the
program made `backend/` the common root, so **every file moved down one level**
to `dist/src/main.js` and `dist/src/serverless.js` — and both deployments ask
for the old paths:

| Asks for | Used by |
|---|---|
| `node dist/main.js` | `infra/docker/Dockerfile.api` (`CMD`) |
| `require('../dist/serverless')` | Vercel (`backend/api/index.js`) |

Both fail with "module not found", the container restarts forever, the Vercel
function answers 500 — and lint, types, unit tests, e2e tests and the build all
stay green, because none of them ever look at `dist/`.

**The fix** is one line in `backend/tsconfig.build.json` (`"scripts"` in
`exclude`), and CI now asserts the layout after the build:

```
✓ dist/main.js
✓ dist/serverless.js
```

`backend/api/index.js` also tries both layouts and answers with the real reason
(and the CORS header the browser needs in order to read it) instead of letting
the platform answer an opaque 500.

**Second half of the same bug: the bundle had no dependencies.** Vercel's
bundler follows literal `require`/`import` statements only. A
`require(variable)` — even a loop over two string constants — hides the whole
graph, and the deployment ships with **no `node_modules`**:

```
AssetFlow API could not be loaded: ../dist/serverless:
Cannot find module '@nestjs/core'
```

`npm run check:bundle` (in CI, after the build) runs the real tracer over
`api/index.js` and fails unless it reaches `dist/serverless.js` and pulls in
`@nestjs/core`, `@prisma/client` and `express`. Keep the requires in
`api/index.js` literal and top-level.

---

## The browser says "blocked by CORS" {#cors-blocked}

**Symptom:** the page loads, the sign-in button does nothing, and the console
shows

```
Access to fetch at 'https://API/api/auth/login' from origin 'https://SPA'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is
present on the requested resource.
```

The SPA and the API are two different sites, so the API has to name the SPA's
origin in `CORS_ORIGINS` before a browser is allowed to read the answer.

**1. What does the API think the list is?** Ask the deployment, not the
dashboard — an environment variable that is set but was never redeployed is
not in the running function.

- **Vercel:** Project → **Logs** → *Runtime Logs*, open the page and reload it.
  The refused origin is now logged with the list that was in effect:
  `Blocked cross-origin request from https://… . CORS_ORIGINS in this deployment is: …`
- **Docker/Compose:** `docker compose logs api | grep -i cors`

**2. Compare it with the address bar.** The value must be exactly what the
browser shows before the path — `https://app.example.com`, no trailing slash,
no path, and `https` if the site is served over https. `http://` ≠ `https://`,
`www.` ≠ apex, and every environment (Production, Preview) has its own copy.

**3. Fix it and redeploy.** Add the origin (comma-separated, no spaces needed —
they are trimmed) and **redeploy**; a saved variable does not reach a running
deployment.

```bash
# Docker
CORS_ORIGINS="https://app.example.com,http://localhost:5173"
docker compose up -d --force-recreate api
```

**4. Still blocked?** If `/api/health` answers a JSON `503` with a `startupError`,
the problem is the environment, not CORS — see [API down](#api-down). If the
API never starts at all, the 503 body is still readable now: the serverless
entrypoint sends `Access-Control-Allow-Origin` with its own error responses, so
the browser console shows the reason instead of a CORS message.

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
| `cannot write to /var/backups/assetflow` | the script ran as a normal user without `BACKUP_DIR` | `BACKUP_DIR=$HOME/backups infra/scripts/backup.sh` (the crontab does this) |
| `InvalidAccessKeyId` | the key in `infra/.env` is wrong, rotated or truncated — secret keys are **40** characters | rotate the key in IAM, update `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, re-run |

**Run it by hand** (the same way the timer does):

```bash
sudo -u assetflow /opt/assetflow/infra/scripts/backup.sh
```

> **On the current host** the checkout is `/home/ubuntu/assetflow` and the dumps
> live in `/home/ubuntu/backups` — not the `/opt/assetflow` layout the systemd
> units assume (those units are for a root install; none are installed here).
> The schedule is a user crontab, so nothing needs root:
>
> ```bash
> crontab -l
> # BACKUP_DIR=/home/ubuntu/backups
> # LOG_DIR=/home/ubuntu/backups/logs
> # 30 2 * * * cd /home/ubuntu/assetflow && ./infra/scripts/backup.sh >> /home/ubuntu/backups/backup-cron.log 2>&1
> # 0 3 * * 0 cd /home/ubuntu/assetflow && ./infra/scripts/restore-verify.sh >> /home/ubuntu/backups/restore-cron.log 2>&1
> ```
>
> `BACKUP_DIR` **must** be set for a non-root run: the script's default is
> `/var/backups/assetflow`, which only root can create, and it now fails with
> that sentence instead of a bare permissions error. The scripts source
> `infra/.env` themselves, so cron needs no other environment.

---

## Sign in with Google is unavailable

The page reads the configuration from the API, so the first check is public:

```bash
curl -fsS https://<host>/api/auth/config
# {"googleClientId":null}  → GOOGLE_CLIENT_ID is not set in the API environment
# {"googleClientId":"…"}   → configured; the problem is the page origin
```

* The button is disabled → set `GOOGLE_CLIENT_ID` in `infra/.env`, then
  `docker compose up -d api`. On this host it is set and `/api/auth/config`
  returns it; the origins registered on the OAuth client are
  `https://13.55.90.25`, `http://localhost:5173`,
  `https://localhost:8443` and the Vercel frontend.
* The Google button renders but the popup closes with nothing → the browser
  console shows the reason; `origin_mismatch` means the exact origin (scheme +
  host + port, no path, no trailing slash) is missing from that list.
* The popup says the origin is not allowed → add the exact origin
  (`https://<host>`, no path) under **Authorized JavaScript origins** in the
  Google Cloud OAuth client.
* `503 Google sign-in is not configured` → same as the null case.
* `401 Google sign-in failed` → the token was expired, malformed or issued for
  another client id; retry from the page. The API deliberately does not echo
  the verification error.

## First administrator {#first-administrator}

**Symptom:** a fresh deployment has no administrator, so nobody can approve
assets, change a role or open Organisation Setup.

Signing up can only ever create an `EMPLOYEE` — by design, because a public
endpoint that grants `ADMIN` is a hole, not a feature. The first admin is
therefore created in three steps, on the server, once:

1. **Sign up normally** in the app with the address that should own the
   deployment. Note the exact spelling.
2. **Set the variable and restart the API.**

   ```bash
   # Vercel: Project → Settings → Environment Variables → add for Production
   BOOTSTRAP_ADMIN_EMAIL="you@your-domain.example"
   ```

   ```bash
   # Self-hosted: infra/.env, then recreate the API container
   echo 'BOOTSTRAP_ADMIN_EMAIL="you@your-domain.example"' >> infra/.env
   docker compose -f infra/docker-compose.yml up -d api
   docker compose -f infra/docker-compose.yml logs --tail 20 api | grep -i bootstrap
   # → Promoted you@your-domain.example to ADMIN (bootstrap). Remove BOOTSTRAP_ADMIN_EMAIL…
   ```

3. **Remove the variable and redeploy.** It has done its job.

What the promotion will and will not do:

| Situation | What happens |
|---|---|
| An **active** admin already exists | nothing; the log says so |
| The address has **no account** | nothing is created; the log asks you to sign up first |
| The account is `INACTIVE` | nothing; reactivate it (as an admin) or use another address |
| The account exists and is active, no admin exists | promoted to `ADMIN` + an activity-log row with `source: "bootstrap"` + a notification |

**One-off promotion at any other time** (local development, or a second admin
before the first has signed in):

```bash
cd backend
npm run promote -- someone@example.com ADMIN          # ADMIN | ASSET_MANAGER | DEPARTMENT_HEAD | EMPLOYEE
```

It refuses to demote the last active administrator, refuses an unknown address
(it never creates users) and writes an activity-log row with `source: "cli"`.

> **Never run `npm run seed` against a deployed database.** It creates
> `admin@assetflow.com` with the published password `password123`. The script
> refuses to run when `NODE_ENV=production` for exactly that reason.

## Nobody can sign in / the reset mail does not arrive

**Symptom:** "Forgot password?" says a link is on its way and nothing arrives.

The API answers `202` for every address, so a missing mail is the *expected*
answer when the address has no account, when the account is deactivated, and
when it is a Google-only account (there is no password to reset).

```bash
# 1. Did the API actually send anything?
#    MAIL_TRANSPORT=dev → the message is a file, not an e-mail:
ls -lt backend/var/mail | head            # self-hosted: /opt/assetflow/backend/var/mail
docker compose -f infra/docker-compose.yml logs --tail 50 api | grep -i 'reset mail'

# 2. Was a reset mail configured at all?
docker compose -f infra/docker-compose.yml exec api printenv | grep -E 'MAIL_|SMTP_URL|FRONTEND_URL'
#    MAIL_TRANSPORT=dev → nothing is ever sent: set MAIL_TRANSPORT=smtp + SMTP_URL
#    (the API refuses to boot with MAIL_TRANSPORT=smtp and no SMTP_URL)

# 3. Does the link point at the right host?
#    FRONTEND_URL must be the browser origin, no trailing slash:
#    FRONTEND_URL="https://assetflow.vercel.app"
```

The link is single-use and expires after 30 minutes; requesting a new one
invalidates the previous one, so **always open the newest e-mail**.

**Locked out of the only admin account:** the reset link restores access. If
the mailbox is gone too, promote another existing account:

```bash
cd backend && npm run promote -- someone@example.com ADMIN
```

## Rotate a leaked credential

```bash
# 1. The password: sign in as the user → /profile → Change password.
#    That bumps tokenVersion, so every session open before it is signed out.

# 2. Everything else on that account: /profile → Sign out everywhere
#    (POST /api/auth/logout-everywhere).
curl -X POST https://<host>/api/auth/logout-everywhere -H "Authorization: Bearer <token>"

# 3. A leaked SEED account on a database you care about:
psql "$DATABASE_URL" -c "UPDATE \"User\" SET status='INACTIVE' WHERE email='admin@assetflow.com';"
#    (do this only after a real admin exists — see "First administrator" above)
```

## Renew the TLS certificate

```bash
cd /opt/assetflow
infra/scripts/renew-cert.sh        # renew + reload; cron runs it daily
docker compose -f infra/docker-compose.yml exec nginx nginx -s reload
openssl x509 -enddate -noout -in infra/certs/live/assetflow/fullchain.pem
```

## The alerts do not arrive

```bash
docker compose logs --tail 50 alertmanager
curl -sS http://127.0.0.1:9093/api/v2/status | head -30
```

* Is the rule firing? → `http://127.0.0.1:9090/alerts` (through the tunnel).
* Is Alertmanager sending it? → **the metric, not the log**:
  ```bash
  curl -s http://127.0.0.1:9093/metrics | grep 'alertmanager_notifications_'
  # alertmanager_notifications_total{integration="telegram"} 3
  # a non-zero ..._failed_total is the actual failure signal; successful sends
  # are logged at debug level, so an empty log proves nothing
  ```
* Is the Telegram token right? → `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
  in `infra/.env`, then `docker compose up -d alertmanager` (the config is a
  template — it is rendered at start). Check the pair *before* restarting:
  ```bash
  curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"
  curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getChat?chat_id=$TELEGRAM_CHAT_ID"
  ```
  A bot cannot message a chat that has never messaged it: press **Start** in
  the chat first, or `getChat` answers `chat not found`.

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

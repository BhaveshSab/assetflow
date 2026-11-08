# The AssetFlow infrastructure

The self-hosted deployment of AssetFlow: one Ubuntu host, several containers,
one public entry point.

```
internet ──▶ nginx (443, TLS) ──┬──▶ api (4000) ──▶ postgres
                                │                  └▶ redis
                                └──▶ the built React SPA (static files)

prometheus ──▶ api, node-exporter, postgres-exporter     (internal network)
           ──▶ cadvisor         (per-container memory)
           ──▶ blackbox          ▶ the public HTTPS endpoint (certificate expiry)
grafana    ──▶ prometheus                                  (127.0.0.1 only)
alertmanager ─▶ telegram
```

## The files

| Path | What it is |
|------|------------|
| `docker-compose.yml` | the stack — production shaped: the database and Redis have no route to the internet, the monitoring tools are bound to `127.0.0.1` |
| `docker-compose.local.yml` | the override for the laptop demo (opens the API port, removes the resource limits) |
| `docker/Dockerfile.api` | the API image — multi-stage, non-root, with a health check |
| `docker/Dockerfile.nginx` | Nginx + the built SPA (same-origin API calls) |
| `nginx/` | the TLS configuration, the security headers, the rate limit |
| `prometheus/` | the static scrape configuration, file-discovered public targets, production alert rules and separate `tests/` fixtures |
| `blackbox/` | the probe configuration for the certificate-expiry metric |
| `grafana/` | the provisioned dashboard |
| `alertmanager/` | the Telegram receiver (a template — the credentials come from the environment) |
| `scripts/` | backup, restore verification, archiving, hardening, deployment, alerts, certificate, host provisioning, the saturation test and the rebuild drill |
| `systemd/` | the timers that run the backup and the restore verification |
| `certs/` · `certbot-www/` | **generated** TLS material and ACME challenges — bind-mounted into Nginx, never committed (`.gitignore`) |

## The alert rules, and how they are tested

`prometheus/rules/assetflow.yml` holds 18 rules in seven groups. There is one
cAdvisor service and one blackbox exporter (`blackbox`); their endpoints have
no published ports. Prometheus contacts them over private Docker networks.

| Group | Rules |
|-------|-------|
| `assetflow-api` | API unavailable, 5xx ratio, p95 latency |
| `assetflow-host` | disk warnings/critical, memory and CPU pressure |
| `assetflow-data` | Postgres unavailable/connections, backup age, rate-limit Redis |
| `assetflow-containers` | actual OOM events and service-level restart loop |
| `assetflow-https` | certificate warning and public HTTPS readiness failure |
| `assetflow-container-capacity` | near-limit memory and API process restarts |
| `assetflow-tls` | critical certificate expiry below three days |

Production `rules/` contains only rules. All fixtures live under `tests/`:
`alerts.test.yml` checks state/labels, timing, thresholds and recovery;
`legacy-alerts.test.yml` preserves PR21 coverage including annotation text.
The critical disk test uses 96% usage; 90% does not trigger the >95% rule.
The legacy API restart condition becomes true at minute 6 and fires after its
five-minute hold at minute 11, not minute 10.

Run from the repository root:

```bash
docker run --rm -v "$PWD/infra/prometheus:/etc/prometheus:ro" --entrypoint promtool \
  prom/prometheus:v2.54.1 check config /etc/prometheus/prometheus.yml
docker run --rm -v "$PWD/infra/prometheus:/etc/prometheus:ro" --entrypoint promtool \
  prom/prometheus:v2.54.1 test rules /etc/prometheus/tests/alerts.test.yml /etc/prometheus/tests/legacy-alerts.test.yml
```

The public URL is in `prometheus/targets/https.yml`, not a rendered
`PUBLIC_BASE_URL` placeholder. TLS verification is enabled. If the certificate
uses a short-lived IP profile, review the 14-day warning threshold against its
lifetime before enabling notifications; the critical expiry rule is three days.
CI runs the nightly isolated regression; `Performance` remains available as a
manual workflow without scheduling a second duplicate nightly load test.

Two things to know when editing:

1. **A new or renamed metric must come with a test case.** A rule whose metric
   no longer exists never fires, and a rule that never fires looks exactly like
   a rule that was never needed.
2. **The test clock starts at 0 (1970),** so "the backup is older than 26
   hours" is expressed as a timestamp far in the past, not as `0`.

## The two drills

Two scripts answer the two questions an interviewer actually asks.

```bash
# 1. How far does it go, and what breaks first?
#    Walks 5 → 200 VUs, samples CPU/memory/Postgres once a second, stops at the
#    first stage that breaks the thresholds, writes docs/results/load-test-<ts>.md.
BASE_URL=https://3.107.83.86.sslip.io infra/scripts/load-test.sh

# 2. What happens when the server is gone?
#    Two phases, because a script cannot survive the machine it is running on.
sudo infra/scripts/rebuild-drill.sh --phase teardown --allow-instance-id i-0123...   # on the old host
infra/scripts/rebuild-drill.sh --phase rebuild --run <stamp>                          # on your laptop
infra/scripts/rebuild-drill.sh --phase report  --run <stamp>
```

`rebuild-drill.sh` refuses to terminate anything unless the newest dump is in
S3, younger than 26 hours and its SHA-256 checks out — then it re-associates
the Elastic IP as its first action, so the address (and every link to it)
survives. `provision-host.sh` is the step it calls: it turns a bare Ubuntu box
into this host, idempotently, and records how long each step took.

The load test needs several identities to get past the API's own limit (300
requests a minute per client), so it seeds a throwaway fixture:

```bash
npm run seed:loadtest -- --users 30 --assets 5000   # in the backend directory
npm run seed:loadtest -- --delete
```

## The first run (laptop)

```bash
cd assetflow
cp infra/.env.example infra/.env
$EDITOR infra/.env                    # the passwords and the JWT secret

sudo infra/scripts/issue-cert.sh --self-signed   # writes infra/certs, mounted into Nginx

docker compose -f infra/docker-compose.yml \
               -f infra/docker-compose.local.yml up -d --build

open https://localhost:8443
```

Google sign-in is optional. Put the **public** client id (no client secret)
in `infra/.env` and restart the API:

```bash
GOOGLE_CLIENT_ID="1234567890-abc.apps.googleusercontent.com"
docker compose -f infra/docker-compose.yml up -d api
```

The ports come from `infra/.env`:

| Variable | Laptop | Server |
|----------|--------|--------|
| `HTTP_PORT` | `8080` | `80` |
| `HTTPS_PORT` | `8443` | `443` |
| `CORS_ORIGINS` | `https://localhost:8443` | `https://<your-host>` |

On the laptop the monitoring stays on `127.0.0.1`
(Grafana on <http://localhost:3001>, Prometheus on <http://localhost:9090>) —
on a server those ports are reachable through an SSH tunnel only.

> The local override must **not** repeat a port of the base file: compose
> appends lists, and two entries for the same container port are a port
> conflict. That is why the ports are in `infra/.env` and not in the
> override.

## The running deployment

| | |
|---|---|
| Host | AWS EC2 `t3.micro`, `ap-southeast-2b`, Ubuntu, 1 GB RAM, 30 GB gp3 |
| Entry point | <https://13.55.90.25> — a Let's Encrypt **IP certificate** (SAN `IP:13.55.90.25`), 6-day lifetime, renewed daily by cron |
| Containers | 9 running: nginx, api, postgres, redis, prometheus, grafana, alertmanager, node-exporter, postgres-exporter. The repo also defines `cadvisor` and `blackbox` (container memory + certificate expiry); they need one `deploy.sh` run to appear |
| Health | `{"status":"ok","database":"up","rateLimitStore":"redis","redis":"up"}` |

The measurements are in [`../docs/results`](../docs/results):

| | |
|---|---|
| Load test (25 VUs, 3 min) | 4,392 requests, **24.23 req/s, p95 35.4 ms, 0.00 % failed** |
| CPU during it | max 43.9 %, avg 21.5 % — the instance has headroom |
| Backup → verified restore | 43 KiB dump, **RTO 8 s** local / **14 s** from S3, checksum + row-by-row comparison |
| Failed deploy → rollback | **48 s** back to the previous, healthy image |
| Redis limiter across a restart | the counter survived `docker compose restart api` |

**On this host, all three are now live:** `S3_BUCKET` is the dedicated
`assetflow-backups-bhavesh-2026` — versioned, public access blocked, SSE-AES256,
`DenyInsecureTransport`, lifecycle *30 d → Glacier Instant Retrieval, expire
365 d* — and a 43 KiB dump with its SHA-256 sits in
`s3://assetflow-backups-bhavesh-2026/assetflow/backups/`. Telegram delivers
(`alertmanager_notifications_total{integration="telegram"} 3`, zero failures),
and `GOOGLE_CLIENT_ID` is set so the sign-in page renders Google's button.
The raw output for each is in [`../docs/results/`](../docs/results).

**Still open:** the host-rebuild drill (the S3 user cannot call `ec2:*`) and the
GitHub deploy workflow (it waits for `DEPLOY_HOST`). See
[`../docs/REBUILD_DRILL.md`](../docs/REBUILD_DRILL.md).

## Deploying a new version

```bash
IMAGE=ghcr.io/bhaveshsab/assetflow-api:<sha> infra/scripts/deploy.sh
```

The script pulls `$IMAGE`, derives the matching `assetflow-migrate:<sha>` tag,
runs the migration with `-T` (so an attached container cannot swallow the
caller's stdin), starts the API with `API_IMAGE`, and requires a **literal
`200`** from `http://127.0.0.1/api/health/ready` — a `301` does not count.
When the check fails it restores the image recorded in
`~/.local/state/assetflow/previous-image` and exits `1`. Measured: **48 s**
from start to a healthy previous version.

> **The GHCR packages are private.** The server must be logged in
> (`docker login ghcr.io` with a `read:packages` token) or the package must be
> made public — otherwise `docker pull` answers `denied` before the deployment
> starts. The GitHub workflow needs the same access.

## The first run (server)

Nginx will not start without a certificate, and Let's Encrypt's HTTP-01
challenge needs Nginx on port 80. So the **first** certificate is a
self-signed bootstrap one; the real certificate is issued through the running
edge and then reloaded:

```bash
sudo infra/scripts/harden-server.sh                # key-only SSH, UFW, updates
sudo infra/scripts/issue-cert.sh --self-signed     # bootstrap for the first boot
docker compose -f infra/docker-compose.yml up -d --build
sudo infra/scripts/issue-cert.sh --domain <host> --email <you@example.com>

# …or for a padlock on a bare IP address (no domain): Let's Encrypt only
# issues those on its shortlived profile, and only certbot >= 5.4 can
# validate an IP over the webroot plugin — a user-level install is fine:
#   sudo CERTBOT=~/.local/bin/certbot infra/scripts/issue-cert.sh \
#        --ip-address <ip> --email <you@example.com>

docker compose -f infra/docker-compose.yml exec nginx nginx -s reload
```

The certificate lives in `infra/certs/live/assetflow` on the host and is
bind-mounted at `/etc/letsencrypt` in the container. Renewal:

```bash
infra/scripts/renew-cert.sh    # renews, then reloads Nginx only if the files changed
```

An **IP certificate lives 160 hours**, so a renewal remembered by hand is a
padlock that disappears. `renew-cert.sh` runs from cron once a day and fails
loudly when fewer than two days remain:

```bash
crontab -l | { cat; echo '17 3 * * * LOG_DIR=$HOME/.local/state/assetflow CERTBOT=$HOME/.local/bin/certbot /opt/assetflow/infra/scripts/renew-cert.sh'; } | crontab -
```

The documentation lives in [`../docs`](../docs):
[architecture](../docs/ARCHITECTURE.md) ·
[runbook](../docs/RUNBOOK.md) ·
[DR drill](../docs/DR_DRILL.md) ·
[decisions](../docs/DECISIONS.md) ·
[costs](../docs/COSTS.md) ·
[AWS setup](../docs/AWS_SETUP.md) ·
[interview Q&A](../docs/INTERVIEW_QA.md) ·
[resume evidence](../docs/RESUME_EVIDENCE.md)

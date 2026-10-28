# The AssetFlow infrastructure

The self-hosted deployment of AssetFlow: one Ubuntu host, several containers,
one public entry point.

```
internet ──▶ nginx (443, TLS) ──┬──▶ api (4000) ──▶ postgres
                                │                  └▶ redis
                                └──▶ the built React SPA (static files)

prometheus ──▶ api, node-exporter, postgres-exporter     (internal network)
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
| `prometheus/` | the scrape configuration and the alert rules |
| `grafana/` | the provisioned dashboard |
| `alertmanager/` | the Telegram receiver (a template — the credentials come from the environment) |
| `scripts/` | backup, restore verification, archiving, hardening, deployment, alerts, certificate |
| `systemd/` | the timers that run the backup and the restore verification |
| `certs/` · `certbot-www/` | **generated** TLS material and ACME challenges — bind-mounted into Nginx, never committed (`.gitignore`) |

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
| Entry point | <https://3.107.83.86.sslip.io> — Let's Encrypt, valid until 2027-01-26 |
| Containers | 9: nginx, api, postgres, redis, prometheus, grafana, alertmanager, node-exporter, postgres-exporter |
| Health | `{"status":"ok","database":"up","rateLimitStore":"redis","redis":"up"}` |

The measurements are in [`../docs/results`](../docs/results):

| | |
|---|---|
| Load test (25 VUs, 3 min) | 4,392 requests, **24.23 req/s, p95 35.4 ms, 0.00 % failed** |
| CPU during it | max 43.9 %, avg 21.5 % — the instance has headroom |
| Backup → verified restore | 43 KB dump, **RTO 9 s**, checksum + row-by-row comparison |
| Failed deploy → rollback | **48 s** back to the previous, healthy image |
| Redis limiter across a restart | the counter survived `docker compose restart api` |

**Open items on this host:** `S3_BUCKET` is empty and the AWS credential is
rejected (`InvalidClientTokenId`), so backups stay on the local disk; the
Telegram token is rejected by the Bot API (`401`), so alerts stop at
Alertmanager; `GOOGLE_CLIENT_ID` is unset, so the sign-in page hides the
Google button. The commands each one needs are in
[`../docs/RESUME_EVIDENCE.md`](../docs/RESUME_EVIDENCE.md).

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
docker compose -f infra/docker-compose.yml exec nginx nginx -s reload
```

The certificate lives in `infra/certs/live/assetflow` on the host and is
bind-mounted at `/etc/letsencrypt` in the container. Renewal:

```bash
sudo certbot renew --config-dir infra/certs --webroot -w infra/certbot-www
docker compose -f infra/docker-compose.yml exec nginx nginx -s reload
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

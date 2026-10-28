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
| `scripts/` | backup, restore verification, archiving, hardening, deployment, alerts |
| `systemd/` | the timers that run the backup and the restore verification |

## The first run (laptop)

```bash
cd assetflow
cp infra/.env.example infra/.env
$EDITOR infra/.env                    # the passwords and the JWT secret

sudo infra/scripts/issue-cert.sh --self-signed   # a demo certificate

docker compose -f infra/docker-compose.yml \
               -f infra/docker-compose.local.yml up -d --build

open https://localhost:8443
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

## The first run (server)

```bash
sudo infra/scripts/harden-server.sh                # key-only SSH, UFW, updates
sudo infra/scripts/issue-cert.sh --domain <host> --email <you@example.com>
docker compose -f infra/docker-compose.yml up -d --build
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

# The interview questions — with the answers from *this* repository

> Twenty questions an interviewer is likely to ask about the infrastructure
> work, and the answer that is true for this stack.
> Learn the **second** column — the third one is what makes it a story.

## The incident questions

### 1. A server's disk is 100% full. How do you find what filled it?

```bash
df -h                                  # which file system?
du -xh --max-depth=1 /var/lib/docker | sort -h | tail   # the biggest directories
docker system df                       # how much do the images and the volumes use?
docker system prune -a --filter "until=168h"
journalctl --disk-usage                 # the system logs
lsof +L1 | head                        # deleted files that are still open
```

**The trap:** a file that was deleted but is still held open by a process
still occupies the disk — `du` does not see it, `lsof +L1` does.

**In this stack:** the suspects are the Docker images, the container logs
(10 MB × 3 per container by configuration) and the backups in
`/var/backups/assetflow` — the runbook has the exact order.

### 2. A service does not start. What is your order?

1. `systemctl status <service>` / `docker compose ps` — is it running at all?
2. `journalctl -u <service> -n 50 --no-pager` / `docker compose logs --tail 100 <service>` — **what does it say?** (read the *first* error, not the last)
3. Is the configuration there? (`grep -E '^[A-Z_]+=' infra/.env`)
4. Is the dependency up? (the database, Redis)
5. Is the port free? (`ss -ltnp | grep 4000`)
6. Are the permissions right? (`ls -l` the .env, `id`)
7. Did something change? (`git log`, `docker compose images`)

### 3. Walk me through a request from the browser to the database.

DNS → TCP → TLS → Nginx → the API container → the rate limiter (Redis) →
Prisma → PostgreSQL → back.

**The details that impress:** the `x-request-id` is generated at the edge (or
passed through) and appears in the JSON log line *and* in the response
header; the API trusts exactly one proxy hop (`trust proxy = 1`), so the
rate limiter sees the real client IP and not the proxy's; the database is on
a network without a route to the internet.

### 4. How do you back up Postgres, and how do you prove the backup works?

`pg_dump --format=custom` (compressed, restorable in parallel) → gzip →
sha256 → S3 (versioned, private, lifecycle rule). The proof is
`restore-verify.sh`: it restores the dump into a **throwaway** container,
runs sanity queries, compares the row counts with the live database and
prints the duration — that duration is the RTO.

**The line that matters:** *"A backup you have never restored is a hope, not
a backup."*

### 5. What does it mean when Redis is down and the app "fails open"?

Fails open = when the dependency is unavailable the system **allows** the
action instead of blocking it. Fails closed = denies it.

**In this project:** the shared rate-limit store fails *open to the local
limiter* — the API keeps serving and still enforces a per-process limit;
the degradation is visible in `GET /api/health` (`redis: "down"`) and in the
`assetflow_throttle_store_degraded` metric, and it fires an alert. Failing
closed would have taken the whole API down because of its own rate limiter.

**The trade-off to say out loud:** during a Redis outage the limit is no
longer global, so a distributed brute-force attempt is slightly easier. That
is the correct trade-off for a monitoring dependency — the alternative (a
total outage) is worse. For an *authentication* dependency I would fail
**closed**.

### 6. How do you upload 2 TB over a 100 Mbps link, and how do you make it resumable?

100 Mbps ≈ 12.5 MB/s → 2 TB ≈ **47 hours** at 100 % utilisation; with a
realistic 60-70 % → **~3 days**.

Resumable: S3 **multipart upload** (parts of 8-64 MB, each with its own
retry), or `rclone`/`rsync --partial` with a checksum. The point: a dropped
connection must not restart the transfer at zero.

**In this stack:** the backup is small, but the archive export uses the same
idea — a file per export, a manifest with the sha256, and the deletion only
after the manifest was verified.

### 7. What do you monitor on a data pipeline, and what pages you at 3 AM?

Pipeline: the ingest rate, the backlog, the error rate, the end-to-end
latency, the **freshness** (the age of the newest record) and the bytes
moved. What pages you: data loss, a growing backlog, a breached freshness
target. What does **not** page you: a high CPU (you scale, you do not wake
up).

**In this stack:** the API (rate, p95, 5xx ratio), the host (CPU, memory,
disk), the database (connections) and the pipeline of the backups (the age of
the last successful backup) — that last one is the metric that turns
"we have backups" into "the backups ran".

### 8. How do you keep a cloud bill under control?

Size the instance from a **measurement** (the load test), not from a guess ·
rotate the logs · a lifecycle rule for the archive (Glacier after 30 days) ·
prune the backups · stop the non-production instances on a schedule · and a
**budget alarm at 50/80/100 %** — created *before* the first resource.

## The design questions

### 9. Why Docker and not a plain `systemd` install?

A reproducible artefact: the same image runs on the laptop, in CI and on the
server. The dependencies are pinned, the process runs as a non-root user and
the rollback is "start the previous image tag" instead of "remember what
npm install did last week".

### 10. Why is the database not published on a port?

Because it does not have to be. The API is the only client; the database sits
on a Docker network with `internal: true` — it has no route to the internet
at all. Fewer open ports, fewer attacks, and the network policy is a file in
the repository instead of a click in a console.

### 11. Why Nginx at all? The app could serve the SPA itself.

Three reasons: TLS termination (the Node process should not handle
certificates), the static files (the hashed assets are cached by the browser
for a year — the API must not serve them), and one place for the security
headers and the edge rate limit. The SPA is also served from the *same*
origin as the API, so there is no CORS configuration at all.

### 12. How do you deploy, and what happens when it fails?

GitHub Actions builds the image, pushes it to the registry and calls
`deploy.sh` over SSH. The script pulls the image, runs the migrations in a
one-shot container, starts the new version and **polls the readiness
endpoint**. If it does not become healthy, it starts the previous image
again — the rollback is automatic, because at 3 AM nobody wants to SSH into a
server.

### 13. Why do the migrations not run when the API starts?

Because two replicas would race, and a failed migration would cause a crash
loop instead of a readable error. The migration is a separate, explicit step
that the deployment script runs *before* the new version starts.

### 14. What is your RPO and your RTO?

The RPO is the age of the newest backup (the nightly dump → up to 24 hours;
it gets much better with the WAL/PITR that this project does **not** have).
The RTO is the duration of the restore, measured by the weekly drill. Both
numbers live in [DR_DRILL.md](./DR_DRILL.md) — filled in with my own
measurements.

### 15. What would you improve with more time?

1. WAL archiving + point-in-time recovery (the RPO becomes minutes).
2. A second instance behind a load balancer with a managed PostgreSQL.
3. The logs shipped to S3 (or Loki) instead of only to `docker logs`.
4. A canary deployment: 5 % of the traffic to the new version first.
5. Terraform for the EC2/S3/IAM part, so the cloud is reproducible too.

## The project questions

### 16. What is AssetFlow?

An asset and resource management system: register, allocate, book, maintain
and audit the physical assets of an organisation. NestJS + Prisma +
PostgreSQL behind a React SPA, 212 automated tests, and it is deployed
serverless on Vercel.

### 17. Why did you build the infrastructure yourself?

Because the interesting part of a data-infrastructure role is not the
application — it is the pipeline around it: the backups, the monitoring, the
cost, the failure modes. The application gave me a *real* workload (a
database with growing tables, an API with a real request path and a login
endpoint worth rate-limiting) instead of a toy `hello world` container.

### 18. What was the most interesting bug you found?

The rate limiter: the failed-sign-in counters lived in the process memory.
On the serverless deployment every cold start began with an empty counter —
so the brute-force protection was effectively **bypassed by restarting the
instance**. Moving the counters to Redis made the limit global and durable.
It is also the honest reason Redis is in the stack.

### 19. How do you know the monitoring works?

Because the alerts are **triggered on purpose**:
`infra/scripts/trigger-alerts.sh` stops the API, pretends the backup is
three days old and fills the disk — and the Telegram message arrives. An
alert that was never fired is an alert you do not know works.

### 20. What is the weakest part of the setup?

Single node: no high availability, the backups are logical dumps (no
point-in-time recovery), the secrets live in a file on the host, and the
monitoring is a single Prometheus. For a real deployment I would add WAL
archiving, a managed database and a second instance — the trade-offs are in
[DECISIONS.md](./DECISIONS.md).

### 21. How does "Sign in with Google" work without an OAuth client secret?

Google Identity Services returns a **signed ID token** to the page. The API
verifies it with `google-auth-library` against Google's public keys —
signature, issuer, audience (the client id) and expiry — and requires
`email_verified`. The client id is public, so there is nothing secret to leak;
the authorization-code flow would add a client secret and a redirect URI per
origin without improving this flow. A first sign-in creates an EMPLOYEE; a
verified email that already has a password account links the Google identity
to it, so the person keeps their role and data.

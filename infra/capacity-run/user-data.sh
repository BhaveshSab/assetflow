#!/usr/bin/env bash
#
# EC2 user-data for the AssetFlow capacity run.
#
# Runs ONCE per instance (that is how EC2 user-data works). It therefore installs
# *persistent* systemd units for anything that must survive a reboot, rather than
# claiming to re-run itself every boot.
#
# INPUTS - there is exactly one delivery path, and it is provisioned explicitly:
#
#   Every input is written to /etc/capacity-run/run-config.env by the operator
#   BEFORE launch, and is embedded by the provisioning wrapper
#   infra/capacity-run/render-user-data.sh, which base64s the file into this
#   script's USERDATA payload. No AWS user credentials, no long-lived keys, and no
#   secrets in Git: the operator supplies them at render time from their own
#   environment, and render-user-data.sh refuses to write plaintext credentials.
#
#   The launch time is NOT read from IMDS. EC2 does not expose a launch timestamp
#   under /latest/meta-data/instance/lifecycle (that path is the instance lifecycle
#   *state* action, not a timestamp), and no LaunchTime tag is sent by the launch
#   request. The original deadline is instead provisioned by the operator, who is
#   the only party that knows the launch instant: LAUNCH_EPOCH is written into
#   run-config.env at render time. The guest cannot forge or extend it.
#
# FAIL CLOSED: if any required input is missing or invalid, this script writes a
# FAILED status and terminates the instance. It never starts the app on a partial
# configuration, and it never falls back to "now" for the deadline.

set -euo pipefail

RUN_DIR=/var/lib/assetflow-capacity
RUN_DIR_SRC=/usr/local/lib/capacity-run-src
EVIDENCE_DIR="$RUN_DIR/evidence"
CONFIG=/etc/capacity-run/run-config.env
LOG="$RUN_DIR/bootstrap.log"
APP_DIR=/opt/assetflow

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR" "$RUN_DIR_SRC"
chmod 700 "$RUN_DIR"
exec > >(tee -a "$LOG") 2>&1

say()  { printf '[bootstrap] %s\n' "$*"; }
status() { printf '%s' "$1" > "$EVIDENCE_DIR/bootstrap-status"; }

# Refuse to leave a half-configured host running.
die() {
    printf '[bootstrap][FATAL] %s\n' "$*"
    status "failed: $*"
    # The instance was launched with InstanceInitiatedShutdownBehavior=terminate,
    # so this TERMINATES it and deletes the root volume.
    /sbin/shutdown -h now || true
    exit 1
}

status running

# ------------------------------------------------------------------ 1. inputs
say "== inputs =="
[ -r "$CONFIG" ] || die "missing $CONFIG: no provisioning path, refusing to continue"
# shellcheck disable=SC1090,SC1091
set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

for required in LAUNCH_EPOCH EXPECTED_COMMIT EVIDENCE_TOKEN CAPACITY_HOSTNAME; do
    eval "value=\${$required:-}"
    [ -n "${value:-}" ] || die "$required is empty in run-config.env"
done

# The deadline is the provisioned launch instant, never "now".
case "$LAUNCH_EPOCH" in
    ''|*[!0-9]*) die "LAUNCH_EPOCH is not a unix timestamp: '$LAUNCH_EPOCH'" ;;
esac
DEADLINE_EPOCH=$(( LAUNCH_EPOCH + 14400 ))
NOW=$(date +%s)
if [ "$DEADLINE_EPOCH" -le "$NOW" ]; then
    # Already past the window: do not run, and do not linger.
    die "deadline already passed at bootstrap (deadline=$DEADLINE_EPOCH now=$NOW)"
fi

printf '%s' "$LAUNCH_EPOCH"   > "$EVIDENCE_DIR/launch-epoch"
printf '%s' "$DEADLINE_EPOCH" > "$EVIDENCE_DIR/deadline-epoch"
printf '%s' "$EXPECTED_COMMIT" > "$EVIDENCE_DIR/expected-commit"
say "deadline $DEADLINE_EPOCH ($(( DEADLINE_EPOCH - NOW ))s remaining)"

# ------------------------------------ 2. deadline mechanism before anything
# Installed BEFORE packages/build: a wedged apt run must not leave the guest
# alive with no enforcement.
say "== deadline (pre-packages) =="
# Embedded by the renderer: not cloned yet, and must not depend on the network.
install -d -m 0755 /usr/local/lib/capacity-run
[ -s "$RUN_DIR_SRC/deadline-guard.sh" ] || die "deadline guard was not embedded in the payload"
install -m 0755 "$RUN_DIR_SRC/deadline-guard.sh" /usr/local/lib/capacity-run/deadline-guard.sh

cat > /etc/systemd/system/capacity-deadline.service <<UNIT
[Unit]
Description=capacity run deadline enforcement
After=network.target
[Service]
Type=oneshot
Environment=RUN_DIR=$RUN_DIR
# NO RemainAfterExit: it would keep the unit active after the first check and
# every later timer tick would be a no-op.
ExecStart=/usr/local/lib/capacity-run/deadline-guard.sh
UNIT
cat > /etc/systemd/system/capacity-deadline.timer <<UNIT
[Unit]
Description=capacity run deadline timer (absolute, launch-based)
[Timer]
OnBootSec=10s
OnUnitActiveSec=60s
AccuracySec=1s
Unit=capacity-deadline.service
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now capacity-deadline.timer || die "deadline timer failed"
systemctl is-active capacity-deadline.timer > "$EVIDENCE_DIR/deadline-timer-state" 2>&1 || true

# ------------------------------------------------------------- 2. packages
say "== packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git openssl jq python3 tar >/dev/null
if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
fi
# 1 GB of RAM cannot build the image; swap is required, not optional.
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
fi

# ---------------------------------------------------------------- 3. code
say "== code =="
rm -rf "$APP_DIR"
git clone -q https://github.com/BhaveshSab/assetflow "$APP_DIR"
git -C "$APP_DIR" checkout -q "$EXPECTED_COMMIT" \
    || die "cannot check out pinned commit $EXPECTED_COMMIT"
DEPLOYED=$(git -C "$APP_DIR" rev-parse HEAD)
printf '%s' "$DEPLOYED" > "$EVIDENCE_DIR/deployed-commit"
[ "$DEPLOYED" = "$EXPECTED_COMMIT" ] || die "deployed $DEPLOYED != expected $EXPECTED_COMMIT"

# ---------------------------------------------------------------- 4. app config
# compose has no defaults for POSTGRES_PASSWORD/REDIS_PASSWORD, so it cannot
# start without these. Generated per run; nothing shared with production.
say "== application configuration =="
for required in POSTGRES_PASSWORD REDIS_PASSWORD GRAFANA_ADMIN_PASSWORD JWT_SECRET; do
    eval "value=\${$required:-}"
    [ -n "${value:-}" ] || die "$required is empty: compose cannot start"
done
[ "${#JWT_SECRET}" -ge 32 ] || die "JWT_SECRET must be >= 32 chars in production"
mkdir -p "$APP_DIR/infra"
umask 077
cat > "$APP_DIR/infra/.env" <<ENVEOF
POSTGRES_USER=${POSTGRES_USER:-assetflow}
POSTGRES_DB=${POSTGRES_DB:-assetflow}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
JOBS_ENABLED=false
JOBS_REDIS_PASSWORD=${REDIS_PASSWORD}
JWT_SECRET=${JWT_SECRET}
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
NODE_ENV=production
METRICS_ENABLED=true
OTEL_ENABLED=false
HTTP_PORT=${HTTP_PORT:-8080}
HTTPS_PORT=${HTTPS_PORT:-8443}
ENVEOF
chmod 600 "$APP_DIR/infra/.env"

# ---------------------------------------------------------------- 5. deploy
say "== deploy =="
cd "$APP_DIR"
COMPOSE="docker compose --env-file infra/.env -f infra/docker-compose.yml"
$COMPOSE config >/dev/null || die "compose config rejected the generated environment"
$COMPOSE up -d postgres redis || die "dependency services failed"
$COMPOSE up -d migrate        || die "migration failed"

# ---------------------------------------------------------------- 6. seed
# `npm prune --omit=dev` strips ts-node from the api runtime image, so seeding
# cannot run there. The migrate image is built from the builder stage and still
# has ts-node + prisma/.
say "== fixtures =="
USERS="${FIXTURE_USERS:-200}"
$COMPOSE run --rm --no-deps migrate \
    npm run seed:loadtest -- --run-id "${RUN_ID}" --users "$USERS" \
    > "$EVIDENCE_DIR/seed.log" 2>&1 || die "fixture seeding failed"

# Proof is a COUNT IN THE DATABASE, not the seed exit code nor a written file.
SEEDED=$($COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-assetflow}" \
    -d "${POSTGRES_DB:-assetflow}" -tAc \
    "SELECT count(*) FROM \"User\" WHERE email LIKE 'loadtest-${RUN_ID}-%@assetflow.test'" \
    2>/dev/null | tr -d '[:space:]')
case "$SEEDED" in
    ''|*[!0-9]*) die "could not count seeded accounts (got '${SEEDED}')" ;;
esac
printf '%s' "$SEEDED" > "$EVIDENCE_DIR/fixture-users"
[ "$SEEDED" -ge "$USERS" ] || die "only $SEEDED accounts exist, expected $USERS"
say "verified $SEEDED run-owned accounts in the database"

$COMPOSE up -d api nginx || die "application services failed"

# ---------------------------------------------------------------- 7. health
# API listens on 4000; readiness route /api/health/ready. Probed with `node`
# because curl is not in the image.
say "== application health =="
for i in $(seq 1 90); do
    if $COMPOSE exec -T api node -e \
        "fetch('http://127.0.0.1:4000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
        >/dev/null 2>&1; then
        echo healthy > "$EVIDENCE_DIR/app-health"
        break
    fi
    [ "$i" -eq 90 ] && die "application readiness never passed"
    sleep 5
done

# Fetch the edge too: a health flag alone is not a working application.
EDGE_CODE=$($COMPOSE exec -T api node -e \
    "fetch('http://nginx/api/health/ready').then(r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log(0);process.exit(0)})" \
    2>/dev/null | tr -d '[:space:]')
printf '%s' "${EDGE_CODE:-0}" > "$EVIDENCE_DIR/edge-health"

# ------------------------------------- 8. single public edge on ONE port
# The client may only be allowed one inbound port, and approving that port must
# actually let the load generator reach the APPLICATION. nginx here is a small
# reverse proxy on 8443 that routes by path:
#
#   /evidence/<name>.tar.gz  -> the Python evidence server (loopback 9443)
#   everything else          -> the application edge (nginx container, 8080)
#
# One port, two destinations, no wideneing of source CIDRs, and no change to the
# application's own limiters: /api still passes through the app nginx with its
# limit_req zone and burst=200 exactly as configured.
#
# TLS is terminated here with the operator-supplied certificate, so the client
# verifies capacity-run.test on 8443 for both the application and the evidence.
say "== single-port edge =="

# Bind the application edge to loopback only: it must not be reachable directly.
# The compose file publishes "${HTTP_PORT:-80}:80"; setting HTTP_PORT to a
# loopback address keeps the app reachable by this proxy alone.
docker compose --env-file infra/.env -f infra/docker-compose.yml stop nginx >/dev/null 2>&1 || true
sed -i 's|^HTTP_PORT=.*|HTTP_PORT=127.0.0.1:8080|' infra/.env
sed -i 's|^HTTPS_PORT=.*|HTTPS_PORT=127.0.0.1:8440|' infra/.env
$COMPOSE up -d nginx || die "application edge failed to restart on loopback"

# The evidence server moves to a loopback-only port; nothing external is exposed
# except the proxy.
cat > /etc/systemd/system/capacity-evidence.service <<UNIT
[Unit]
Description=capacity run evidence endpoint (loopback only)
After=network-online.target
[Service]
Environment=EVIDENCE_DIR=$EVIDENCE_DIR
EnvironmentFile=/etc/capacity-run/evidence.env
ExecStart=/usr/bin/python3 $APP_DIR/infra/scripts/evidence_server.py --cert /etc/capacity-run/tls.crt --key /etc/capacity-run/tls.key --port 9443 --host 127.0.0.1
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
printf 'EVIDENCE_TOKEN=%s\n' "$EVIDENCE_TOKEN" > /etc/capacity-run/evidence.env
chmod 600 /etc/capacity-run/evidence.env
systemctl daemon-reload
systemctl enable --now capacity-evidence.service || die "evidence endpoint failed"

# The certificate covers capacity-run.test; the app's own nginx inside compose
# uses its own cert, which this proxy does not consume.
# Static edge config lives in the repo; user-data is capped at 16 KiB.
mkdir -p /etc/capacity-run-proxy
install -m 0644 "$APP_DIR/infra/capacity-run/edge/nginx.conf" /etc/capacity-run-proxy/nginx.conf
install -m 0644 "$APP_DIR/infra/capacity-run/edge/edge.conf" /etc/capacity-run-proxy/edge.conf

# No host nginx: run the edge as a host-network container.
docker rm -f capacity-edge >/dev/null 2>&1 || true
docker run -d --name capacity-edge --restart unless-stopped --network host \
    -v /etc/capacity-run-proxy:/etc/capacity-edge:ro \
    -v /etc/capacity-run:/etc/capacity-run:ro \
    -v /var/log/nginx:/var/log/nginx \
    nginx:1.27-alpine \
    nginx -c /etc/capacity-edge/nginx.conf -g 'daemon off;' \
    || die "single-port edge failed to start"

# Verify the proxy actually reaches both destinations before declaring ready.
for i in $(seq 1 30); do
    A=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/api/health/ready || echo 0)
    E=$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $EVIDENCE_TOKEN" https://127.0.0.1:8443/evidence/snapshot-latest.tar.gz || echo 0)
    [ "$A" = "200" ] && [ "$E" = "200" ] && break
    [ "$i" -eq 30 ] && die "single-port edge cannot reach app ($A) or evidence ($E)"
    sleep 2
done
printf 'app=%s evidence=%s\n' "$A" "$E" > "$EVIDENCE_DIR/edge-routing"
say "edge: app /api -> 8080, evidence /evidence -> 9443 (both 200)"

# ------------------------------------------------- 6. persistent units
# These are real installed units, not transient ones, so a reboot keeps them.
say "== lifecycle + metrics units =="
printf '[Unit]\nDescription=cap metrics\nAfter=network-online.target\n[Service]\nEnvironment=RUN_DIR=%s\nEnvironment=METRICS_INTERVAL=1\nExecStart=/bin/bash %s/infra/capacity-run/collect-metrics.sh\nRestart=always\n[Install]\nWantedBy=multi-user.target\n' "$RUN_DIR" "$APP_DIR" > /etc/systemd/system/capacity-metrics.service

printf '[Unit]\nDescription=cap snapshot\n[Service]\nType=oneshot\nExecStart=/bin/bash %s/infra/capacity-run/snapshot-evidence.sh\n' "$APP_DIR" > /etc/systemd/system/capacity-snapshot.service
printf '[Unit]\nDescription=cap snapshot timer\n[Timer]\nOnBootSec=60s\nOnUnitActiveSec=60s\nUnit=capacity-snapshot.service\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/capacity-snapshot.timer

systemctl daemon-reload
systemctl enable --now capacity-metrics.service  || die "metrics service failed"
systemctl enable --now capacity-snapshot.timer   || die "snapshot timer failed"

# Record what is actually enabled, for the operator to read back.
systemctl list-timers --all > "$EVIDENCE_DIR/timers.txt" 2>&1 || true
systemctl is-enabled capacity-deadline.timer > "$EVIDENCE_DIR/deadline-timer-enabled" 2>&1 || true

status ready
say "bootstrap done; deadline $DEADLINE_EPOCH"

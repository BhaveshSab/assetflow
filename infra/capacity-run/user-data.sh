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

# Diagnostics must reach a place a post-mortem can read even when the journal is
# unwritable and the root volume is full. /dev/console is the EC2 system log.
console_log() {
    printf 'capacity-bootstrap: %s\n' "$1"
    if [ -w /dev/console ]; then
        printf 'capacity-bootstrap: %s\n' "$1" > /dev/console 2>/dev/null || true
    fi
}

STAGE="pre-bootstrap"
say()  { printf '[bootstrap] %s\n' "$*"; }
status() { printf '%s' "$1" > "$EVIDENCE_DIR/bootstrap-status"; }

# A stage marker at entry and completion, so a silent death still names the last
# stage entered and whether it finished.
stage_begin() { STAGE="$1"; console_log "stage-begin: $1"; say "== $1 =="; }
stage_done()  { console_log "stage-done: $1"; say "== $1 done =="; }

# Refuse to leave a half-configured host running.
die() {
    printf '[bootstrap][FATAL] %s\n' "$*" >&2
    console_log "FATAL: $* (stage=$STAGE line=${BASH_LINENO[0]:-?})"
    status "failed: $*"
    # The instance was launched with InstanceInitiatedShutdownBehavior=terminate,
    # so this TERMINATES it and deletes the root volume.
    /sbin/shutdown -h now || true
    exit 1
}

# `set -e` alone does not describe an unguarded failure, and a failure inside a
# function or subshell would otherwise report nothing at all. Named rather than
# inline so the body is readable and statically checkable.
on_error() {
    local rc="$?"
    if [ "$rc" -ne 0 ]; then
        printf '[bootstrap][FATAL] unexpected failure rc=%s at line %s (stage=%s)\n' \
            "$rc" "$1" "$STAGE" >&2
        console_log "FATAL unexpected rc=$rc line=$1 stage=$STAGE"
        status "failed: rc=$rc line=$1 stage=$STAGE"
        /sbin/shutdown -h now || true
    fi
}
trap 'on_error "$LINENO"' ERR

# Marked before the config is sourced, so the variables are not yet set and `set -u`
# would abort here. This has to survive being the first thing that runs.
console_log "bootstrap-start run=${RUN_ID:-unset} commit=${EXPECTED_COMMIT:-unset}"
status running

# ------------------------------------------------------------------ 1. inputs
stage_begin "inputs"
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
stage_begin "deadline (pre-packages)"
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
stage_begin "packages"
export DEBIAN_FRONTEND=noninteractive
# Network and package steps are bounded: a wedged apt or a hung download must not
# consume the whole lifetime silently, and a timeout must name itself.
bounded() {
    local limit="$1"; shift
    timeout "$limit" "$@" || die "step timed out after ${limit}s: $*"
}
bounded 600 apt-get update -qq
bounded 900 apt-get install -y -qq ca-certificates curl gnupg git openssl jq python3 tar >/dev/null
if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list
    bounded 600 apt-get update -qq
    bounded 900 apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
fi
stage_done "packages"
# 1 GB of RAM cannot build the image; swap is required, not optional.
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
fi

# ------------------------------------------------- 2b. disk preflight
# The first real run died here, not in any application code: the image export hit
# "failed to write compressed diff / no space left on device", journald hit the
# same thing, and the bootstrap reported only the generic "migration failed".
# Free space is checked before any build work so an under-sized root volume is
# reported as an under-sized root volume, while there is still room to say so.
MIN_FREE_MB=${MIN_FREE_MB:-12000}
free_mb() { df -Pm /var/lib/docker 2>/dev/null || df -Pm /; }
AVAIL_MB=$(free_mb | awk 'NR==2{print $4}')
TOTAL_MB=$(df -Pm / | awk 'NR==2{print $2}')
say "disk: root=${TOTAL_MB}MB available=${AVAIL_MB}MB required=${MIN_FREE_MB}MB"
printf 'root_mb=%s avail_mb=%s required_mb=%s\n' "$TOTAL_MB" "$AVAIL_MB" "$MIN_FREE_MB" \
    > "$EVIDENCE_DIR/disk-preflight"
if [ -z "$AVAIL_MB" ] || [ "$AVAIL_MB" -lt "$MIN_FREE_MB" ]; then
    die "insufficient disk: ${AVAIL_MB:-unknown}MB free, ${MIN_FREE_MB}MB required (root=${TOTAL_MB:-unknown}MB)"
fi

# ---------------------------------------------------------------- 3. code
stage_begin "code"
rm -rf "$APP_DIR"
git clone -q https://github.com/BhaveshSab/assetflow "$APP_DIR"
git -C "$APP_DIR" checkout -q "$EXPECTED_COMMIT" \
    || die "cannot check out pinned commit $EXPECTED_COMMIT"
DEPLOYED=$(git -C "$APP_DIR" rev-parse HEAD)
printf '%s' "$DEPLOYED" > "$EVIDENCE_DIR/deployed-commit"
[ "$DEPLOYED" = "$EXPECTED_COMMIT" ] || die "deployed $DEPLOYED != expected $EXPECTED_COMMIT"
stage_done "code"

# ---------------------------------------------------------------- 4. app config
# compose has no defaults for POSTGRES_PASSWORD/REDIS_PASSWORD, so it cannot
# start without these. Generated per run; nothing shared with production.
stage_begin "application configuration"
for required in POSTGRES_PASSWORD REDIS_PASSWORD GRAFANA_ADMIN_PASSWORD JWT_SECRET LOADTEST_PASSWORD; do
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
stage_begin "deploy"
cd "$APP_DIR"

# Images are pinned to this run by migrate-db.sh, which also builds them from the
# checked-out commit. A run-local tag cannot be pulled, so the build is the only
# way the image can exist - that closes the defect where `up -d migrate` pulled
# ghcr.io/...:latest from another revision.
COMPOSE="docker compose --env-file infra/.env -f infra/docker-compose.yml"

# Migration is now a hard gate: build, run in the foreground, require exit 0,
# and verify the database's own schema state. The previous version used
# `up -d migrate`, which returns before the migration finishes, and a log check
# that fell through to say() - it could not fail.
RUN_ID="$RUN_ID" COMPOSE="$COMPOSE" \
    bash "$APP_DIR/infra/capacity-run/migrate-db.sh" \
        --evidence-dir "$EVIDENCE_DIR" --timeout 900 \
    || die "database migration did not complete (see $EVIDENCE_DIR/migrate.log)"
say "migration verified against the database"
stage_done "deploy"

# ---------------------------------------------------------------- 6. seed
stage_begin "fixtures"
# One shared path with CI. The bootstrap used to inline its own copy of this
# command; that copy is how it drifted from CI and pulled a stale image.
USERS="${FIXTURE_USERS:-200}"
LOADTEST_PASSWORD="$LOADTEST_PASSWORD" COMPOSE="$COMPOSE" \
    bash "$APP_DIR/infra/capacity-run/seed-fixtures.sh" \
        --run-id "${RUN_ID}" --users "$USERS" --evidence-dir "$EVIDENCE_DIR" \
    || die "fixture seeding failed (see $EVIDENCE_DIR/seed.log)"
SEEDED="$(tr -d '[:space:]' < "$EVIDENCE_DIR/fixture-users" 2>/dev/null || true)"
say "verified $SEEDED run-owned accounts with stored hashes"
stage_done "fixtures"

stage_begin "application health"
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
stage_begin "single-port edge"

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
stage_begin "lifecycle + metrics units"
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

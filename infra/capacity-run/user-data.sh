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
#   BEFORE launch, and is embedded by infra/capacity-run/render-user-data.sh,
#   which base64s the file into this script's USERDATA payload. No AWS user
#   credentials, no long-lived keys, and no secrets in Git.
#
#   The launch time is NOT read from IMDS (EC2 does not expose it there); the
#   deadline is LAUNCH_EPOCH from run-config.env, provisioned by the operator.
#   The guest cannot forge or extend it.
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
stage_begin() {
    STAGE="$1"
    { printf '%s' "$1" > "$EVIDENCE_DIR/stage-current"; date -u +%s > "$EVIDENCE_DIR/stage-started-at"; } 2>/dev/null || true
    console_log "stage-begin: $1"
    say "== $1 =="
}
stage_done()  { console_log "stage-done: $1"; say "== $1 done =="; }

# Refuse to leave a half-configured host running.

# Bootstrap-error shutdowns must not race the off-host poller (30s sampling):
# hold a bounded window after recording the reason so /status serves it, then
# shut down. The window is capped by the REMAINING approved lifetime and is
# skipped entirely when the deadline cannot be validated (for example a die()
# before the config is sourced): the four-hour limit is a maximum, and
# deadline enforcement itself never waits. Deadline-expired and invalid-
# deadline shutdowns live in deadline-guard.sh and are always immediate.
EW_SECONDS="${EW_SECONDS:-90}"
case "$EW_SECONDS" in ''|*[!0-9]*) EW_SECONDS=90 ;; esac
[ "$EW_SECONDS" -le 180 ] || EW_SECONDS=180

evidence_window() {
    local wait="$EW_SECONDS" now remaining note
    case "${DEADLINE_EPOCH:-}" in
        ''|*[!0-9]*) wait=0 ;;
        *)
            # 120s margin for the shutdown and the fail-closed cleanup after it.
            now=$(date +%s)
            remaining=$(( DEADLINE_EPOCH - now - 120 ))
            if [ "$remaining" -le 0 ]; then
                wait=0
            elif [ "$wait" -gt "$remaining" ]; then
                wait="$remaining"
            fi
            ;;
    esac
    if [ "$wait" -gt 0 ]; then
        note="evidence-window=${wait}s pending"
    else
        note="evidence-window=0s immediate"
    fi
    console_log "evidence window=${wait}s"
    status "failed: $1 ($note)"
    [ "$wait" -gt 0 ] && sleep "$wait" || true
}

die() {
    printf '[bootstrap][FATAL] %s\n' "$*" >&2
    console_log "FATAL: $* (stage=$STAGE line=${BASH_LINENO[0]:-?})"
    # A short marker survives console truncation and is what the status endpoint
    # serves; the console copy may scroll out of the ring buffer before anyone
    # can read it.
    printf 'stage=%s line=%s rc=die one-line=%s\n' \
        "$STAGE" "${BASH_LINENO[0]:-?}" "$*" > "$EVIDENCE_DIR/failure-summary" 2>/dev/null || true
    evidence_window "$*"
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
        printf 'stage=%s line=%s rc=%s\n' \
            "$STAGE" "$1" "$rc" > "$EVIDENCE_DIR/failure-summary" 2>/dev/null || true
        evidence_window "rc=$rc line=$1 stage=$STAGE"
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
[ -r "$CONFIG" ] || die "missing $CONFIG, refusing to continue"
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
    die "deadline passed at bootstrap ($DEADLINE_EPOCH < $NOW)"
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
[ -s "$RUN_DIR_SRC/deadline-guard.sh" ] || die "deadline guard not embedded"
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

# ------------------------------------------- 2a. early diagnostic endpoint
# Started HERE, before packages, builds, migrations and seeding, so a failure
# anywhere after this point is retrievable while it happens. A previous run's
# 58-minute build filled the console ring buffer and the fixture failure
# scrolled out; the operator was left with a log that had already gone.
#
# The script is fetched from the pinned commit rather than embedded: EC2 caps
# user-data at 16 KiB and the payload was already within ~700 bytes of it. The
# repo is public and the bootstrap already clones it, so this adds no credential.
#
# Loopback-only until the single-port edge arrives at the end and proxies
# /status to it. This is NOT a readiness signal: it reports that the guest is
# alive and what stage it is in, never that the application works.
BS=/etc/capacity-run/bs.py
curl -fsSL --max-time 30 "https://raw.githubusercontent.com/BhaveshSab/assetflow/$EXPECTED_COMMIT/infra/capacity-run/bootstrap-status.py" -o $BS || die "no bootstrap-status.py"
# Loopback service emitter. Four units repeated the same [Unit]/[Service]/
# [Install] scaffolding, and user-data is capped at 16 KiB, so it is written
# once here instead of four times inline.
unit() { printf '[Unit]\nDescription=%s\nAfter=network-online.target\n[Service]\n%s\nRestart=always\n[Install]\nWantedBy=multi-user.target\n' "$2" "$3" > "/etc/systemd/system/$1.service"; }

unit capacity-status "cap status" "EnvironmentFile=$CONFIG
ExecStart=/usr/bin/python3 $BS --cert /etc/capacity-run/tls.crt --key /etc/capacity-run/tls.key --run-dir $RUN_DIR --port 9444 --token \$EVIDENCE_TOKEN"
systemctl enable --now capacity-status.service || die "status endpoint failed"
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

# ---------------------------------------- 2c. external diagnostics on 8443
# The status service above is loopback-only and the full edge arrives only at
# the end, so the guest was unreachable from outside for the whole of the build,
# migration and seeding work - exactly the window in which a failure happens.
# The diagnostic channel is published on the one approved port NOW, and nothing
# else is. Reachability begins once packages (docker + the nginx image) are
# available: it is NOT pre-package observability. Body fetched from the pinned
# commit; user-data is capped at 16 KiB.
stage_begin "early status edge"
curl -fsSL "https://raw.githubusercontent.com/BhaveshSab/assetflow/$EXPECTED_COMMIT/infra/capacity-run/early-edge.sh" \
    -o "$RUN_DIR_SRC/early-edge.sh" || die "cannot fetch early-edge.sh"
EXPECTED_COMMIT="$EXPECTED_COMMIT" CAPACITY_HOSTNAME="$CAPACITY_HOSTNAME" \
EVIDENCE_TOKEN="$EVIDENCE_TOKEN" EVIDENCE_DIR="$EVIDENCE_DIR" \
    bash "$RUN_DIR_SRC/early-edge.sh"
stage_done "early status edge"
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
    die "disk: ${AVAIL_MB:-?}MB free, need ${MIN_FREE_MB}MB (root=${TOTAL_MB:-?}MB)"
fi

# ---------------------------------------------------------------- 3. code
stage_begin "code"
rm -rf "$APP_DIR"
git clone -q https://github.com/BhaveshSab/assetflow "$APP_DIR"
git -C "$APP_DIR" checkout -q "$EXPECTED_COMMIT" \
    || die "cannot check out pinned commit $EXPECTED_COMMIT"
DEPLOYED=$(git -C "$APP_DIR" rev-parse HEAD)
printf '%s' "$DEPLOYED" > "$EVIDENCE_DIR/deployed-commit"
[ "$DEPLOYED" = "$EXPECTED_COMMIT" ] || die "deployed $DEPLOYED != $EXPECTED_COMMIT"
stage_done "code"

# ---------------------------------------------------------------- 4. app config
# compose has no defaults for POSTGRES_PASSWORD/REDIS_PASSWORD, so it cannot
# start without these. Generated per run; nothing shared with production.
stage_begin "application configuration"
for v in POSTGRES_PASSWORD REDIS_PASSWORD GRAFANA_ADMIN_PASSWORD JWT_SECRET LOADTEST_PASSWORD; do
    eval "val=\${$v:-}"
    [ -n "$val" ] || die "$v is empty: compose cannot start"
    case "$val" in *[!A-Za-z0-9]*) die "$v is not URL-safe" ;; esac
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
HTTP_PORT=127.0.0.1:8080
HTTPS_PORT=127.0.0.1:8440
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
# Pull the immutable digests CI published for this exact commit. Absent file
# or absent values means build mode, which is what CI itself exercises.
DIGEST_FILE="$APP_DIR/infra/capacity-run/image-digests.env"
# shellcheck disable=SC1090
if [ -r "$DIGEST_FILE" ]; then . "$DIGEST_FILE"; fi
RUN_ID="$RUN_ID" COMPOSE="$COMPOSE" \
FIXTURE_API_DIGEST="${FIXTURE_API_DIGEST:-}" FIXTURE_MIGRATE_DIGEST="${FIXTURE_MIGRATE_DIGEST:-}" FIXTURE_WEB_DIGEST="${FIXTURE_WEB_DIGEST:-}" \
    bash "$APP_DIR/infra/capacity-run/migrate-db.sh" \
        --evidence-dir "$EVIDENCE_DIR" --timeout 2400 \
    || die "database migration did not complete (see $EVIDENCE_DIR/migrate.log)"
say "migration verified against the database"
stage_done "deploy"

# ---------------------------------------------------------------- 6. seed
stage_begin "fixtures"
# One shared path with CI. The bootstrap used to inline its own copy of this
# command; that copy is how it drifted from CI and pulled a stale image.
USERS="${FIXTURE_USERS:-200}"
# The seed runs in the migrate image, so it needs the same pin. Without this it
# would fall back to the compose default tag and could run different code from
# the migration that just succeeded - the defect that made an earlier attempt
# seed against the wrong schema.
LOADTEST_PASSWORD="$LOADTEST_PASSWORD" COMPOSE="$COMPOSE" \
MIGRATE_IMAGE="${FIXTURE_MIGRATE_DIGEST:-assetflow-migrate:${RUN_ID}}" API_IMAGE="${FIXTURE_API_DIGEST:-assetflow-api:${RUN_ID}}" WEB_IMAGE="${FIXTURE_WEB_DIGEST:-assetflow-web:${RUN_ID}}" \
    bash "$APP_DIR/infra/capacity-run/seed-fixtures.sh" \
        --run-id "${RUN_ID}" --users "$USERS" --evidence-dir "$EVIDENCE_DIR" \
    || die "fixture seeding failed (see $EVIDENCE_DIR/seed.log)"
SEEDED="$(tr -d '[:space:]' < "$EVIDENCE_DIR/fixture-users" 2>/dev/null || true)"
say "verified $SEEDED run-owned accounts with stored hashes"
stage_done "fixtures"

stage_begin "application health"
# The stack start and the readiness gate live in the repo, not the payload
# (the same fetch-from-pinned-commit pattern as early-edge.sh): the payload
# was within a few hundred bytes of the 16 KiB EC2 cap.
env COMPOSE="$COMPOSE" EVIDENCE_DIR="$EVIDENCE_DIR" APP_DIR="$APP_DIR" RUN_ID="$RUN_ID" \
    bash "$APP_DIR/infra/capacity-run/app-health.sh" \
    || die "application health step failed (see $EVIDENCE_DIR/stack-up.log; app-health writes its own precise one-liner)"

# ------------------------------------- 8. single public edge on ONE port
# One inbound port (8443): /evidence -> the evidence server, /status -> the
# status service, everything else -> the application edge on 8080. TLS uses the
# operator-supplied certificate; the app's own limiters are untouched.
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
printf 'EVIDENCE_TOKEN=%s\n' "$EVIDENCE_TOKEN" > /etc/capacity-run/evidence.env
chmod 600 /etc/capacity-run/evidence.env
unit capacity-evidence "cap evidence" "Environment=EVIDENCE_DIR=$EVIDENCE_DIR
EnvironmentFile=/etc/capacity-run/evidence.env
ExecStart=/usr/bin/python3 $APP_DIR/infra/scripts/evidence_server.py --cert /etc/capacity-run/tls.crt --key /etc/capacity-run/tls.key --port 9443 --host 127.0.0.1"
systemctl daemon-reload
systemctl enable --now capacity-evidence.service || die "evidence endpoint failed"

# The certificate covers capacity-run.test; the app's own nginx inside compose
# uses its own cert, which this proxy does not consume.
# Static edge config lives in the repo; user-data is capped at 16 KiB.
mkdir -p /etc/capacity-run-proxy
install -m 0644 "$APP_DIR/infra/capacity-run/edge/nginx.conf" /etc/capacity-run-proxy/nginx.conf
install -m 0644 "$APP_DIR/infra/capacity-run/edge/edge.conf" /etc/capacity-run-proxy/edge.conf

# Hand the running early edge over to the full routing config. Same single 8443
# listener for the whole run; see early-edge.sh switch for why there is no port
# conflict and why a reload is preferred to a recreate.
EXPECTED_COMMIT="$EXPECTED_COMMIT" CAPACITY_HOSTNAME="$CAPACITY_HOSTNAME" \
EVIDENCE_TOKEN="$EVIDENCE_TOKEN" EVIDENCE_DIR="$EVIDENCE_DIR" \
    bash "$RUN_DIR_SRC/early-edge.sh" switch

# ------------------------------------------------- 6. persistent units
# These are real installed units, not transient ones, so a reboot keeps them.
stage_begin "lifecycle + metrics units"
unit capacity-metrics "cap metrics" "Environment=RUN_DIR=$RUN_DIR
Environment=METRICS_INTERVAL=1
ExecStart=/bin/bash $APP_DIR/infra/capacity-run/collect-metrics.sh"

printf '[Unit]\n[Service]\nType=oneshot\nExecStart=/bin/bash %s/infra/capacity-run/snapshot-evidence.sh\n' "$APP_DIR" > /etc/systemd/system/capacity-snapshot.service
printf '[Unit]\n[Timer]\nOnBootSec=60s\nOnUnitActiveSec=60s\nUnit=capacity-snapshot.service\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/capacity-snapshot.timer

systemctl daemon-reload
systemctl enable --now capacity-metrics.service  || die "metrics service failed"
systemctl enable --now capacity-snapshot.timer   || die "snapshot timer failed"
# The timer's first elapse can lag the enable by up to its interval, and the
# supervisor's export check needs a published digest within seconds of
# readiness. Run the publisher once NOW so the first archive and its
# .snapshot-latest.meta exist deterministically; the timer keeps it fresh.
systemctl start capacity-snapshot.service        || die "evidence snapshot failed"

# Record what is actually enabled, for the operator to read back.
systemctl list-timers --all > "$EVIDENCE_DIR/timers.txt" 2>&1 || true
systemctl is-enabled capacity-deadline.timer > "$EVIDENCE_DIR/deadline-timer-enabled" 2>&1 || true

status ready
say "bootstrap done; deadline $DEADLINE_EPOCH"

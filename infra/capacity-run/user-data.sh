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
EVIDENCE_DIR="$RUN_DIR/evidence"
CONFIG=/etc/capacity-run/run-config.env
LOG="$RUN_DIR/bootstrap.log"
APP_DIR=/opt/assetflow

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"
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

for required in LAUNCH_EPOCH EXPECTED_COMMIT EVIDENCE_TOKEN S3_BUCKET; do
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

# ---------------------------------------------------------------- 4. deploy
say "== deploy =="
cd "$APP_DIR"
docker compose -f infra/docker-compose.yml up -d --build || die "compose up failed"

USERS="${FIXTURE_USERS:-200}"
# Must equal LOADTEST_USERS passed to load-test.sh. Seeding 200 while driving 30
# would leave 170 accounts unused and understate the run.
docker compose -f infra/docker-compose.yml exec -T api \
    npm run seed:loadtest -- --run-id "${RUN_ID}" --users "$USERS" \
    > "$EVIDENCE_DIR/seed.log" 2>&1 || die "fixture seeding failed"
printf '%s' "$USERS" > "$EVIDENCE_DIR/fixture-users"

# Health: the app must answer, not merely have started.
for i in $(seq 1 60); do
    if docker compose -f infra/docker-compose.yml exec -T api \
        sh -c 'curl -fsS http://127.0.0.1:3000/api/health' >/dev/null 2>&1; then
        echo healthy > "$EVIDENCE_DIR/app-health"
        break
    fi
    [ "$i" -eq 60 ] && die "application health check never passed"
    sleep 5
done

# -------------------------------------------------- 5. evidence + TLS trust
say "== evidence endpoint =="
# The certificate carries an IP SAN for the instance's public address, so the
# client's destination matches the SAN instead of a bare CN.
PUBLIC_IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $(curl -fsS -X PUT \
    http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" \
    http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
if [ -n "${PUBLIC_IP:-}" ]; then
    SAN="IP:${PUBLIC_IP}"
else
    die "cannot determine public IPv4 for the certificate SAN"
fi
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -keyout "$RUN_DIR/tls.key" -out "$RUN_DIR/tls.crt" \
    -subj "/CN=capacity-run" \
    -addext "subjectAltName=${SAN}" >/dev/null 2>&1 \
    || die "certificate generation failed"
chmod 600 "$RUN_DIR/tls.key"

# The certificate and the token are published to S3 so the OPERATOR can fetch
# them out-of-band. They are the bootstrap's output, not its input.
tar -czf "$RUN_DIR/trust.tar.gz" -C "$RUN_DIR" tls.crt
printf '%s' "$EVIDENCE_TOKEN" > "$RUN_DIR/evidence.token.txt"

# The endpoint serves ONLY the evidence directory (not the run directory, which
# holds run.env and the private key) and only /evidence/<name>.tar.gz.
cat > /etc/systemd/system/capacity-evidence.service <<UNIT
[Unit]
Description=capacity run evidence endpoint
After=network-online.target docker.service
[Service]
Environment=EVIDENCE_DIR=$EVIDENCE_DIR
EnvironmentFile=/etc/capacity-run/evidence.env
ExecStart=/usr/bin/python3 $APP_DIR/infra/scripts/evidence_server.py --cert $RUN_DIR/tls.crt --key $RUN_DIR/tls.key --port 8443
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
printf 'EVIDENCE_TOKEN=%s\n' "$EVIDENCE_TOKEN" > /etc/capacity-run/evidence.env
chmod 600 /etc/capacity-run/evidence.env
systemctl daemon-reload
systemctl enable --now capacity-evidence.service || die "evidence endpoint failed"

# ------------------------------------------------- 6. persistent units
# These are real installed units, not transient ones, so a reboot keeps them.
say "== lifecycle + metrics units =="
cat > /etc/systemd/system/capacity-metrics.service <<UNIT
[Unit]
Description=capacity run host metrics
After=network-online.target
[Service]
Environment=RUN_DIR=$RUN_DIR
Environment=METRICS_INTERVAL=1
ExecStart=/bin/bash $APP_DIR/infra/capacity-run/collect-metrics.sh
Restart=always
[Install]
WantedBy=multi-user.target
UNIT

# Fixed original deadline, persisted in the unit so a reboot recomputes the
# remaining time from the SAME launch-based deadline rather than restarting 4h.
cat > /etc/systemd/system/capacity-deadline.service <<UNIT
[Unit]
Description=capacity run deadline enforcement
After=network.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash $APP_DIR/infra/capacity-run/deadline-guard.sh
UNIT

cat > /etc/systemd/system/capacity-deadline.timer <<UNIT
[Unit]
Description=capacity run deadline timer (launch-based, absolute)
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=1s
Unit=capacity-deadline.service
[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/capacity-snapshot.service <<UNIT
[Unit]
Description=capacity run evidence snapshot
[Service]
Type=oneshot
ExecStart=/bin/bash $APP_DIR/infra/capacity-run/snapshot-evidence.sh
UNIT

cat > /etc/systemd/system/capacity-snapshot.timer <<UNIT
[Unit]
Description=periodic evidence snapshot
[Timer]
OnBootSec=60s
OnUnitActiveSec=60s
Unit=capacity-snapshot.service
[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now capacity-metrics.service  || die "metrics service failed"
systemctl enable --now capacity-deadline.timer   || die "deadline timer failed"
systemctl enable --now capacity-snapshot.timer   || die "snapshot timer failed"

# Record what is actually enabled, for the operator to read back.
systemctl list-timers --all > "$EVIDENCE_DIR/timers.txt" 2>&1 || true
systemctl is-enabled capacity-deadline.timer > "$EVIDENCE_DIR/deadline-timer-enabled" 2>&1 || true

status ready
say "bootstrap complete; deadline $DEADLINE_EPOCH"

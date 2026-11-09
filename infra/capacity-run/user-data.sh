#!/usr/bin/env bash
#
# EC2 user-data for the AssetFlow capacity run.
#
# This is the authoritative bootstrap. It is passed to `run-instances
# --user-data file://infra/capacity-run/user-data.sh` and therefore runs on every
# boot, not from a shell on the host (the instance has no key pair and no SSH).
#
# The deadline is computed from the INSTANCE LAUNCH TIME, read from the EC2 API,
# not from when this script finishes. A slow or failed bootstrap must not buy the
# run extra time: with a launch-time deadline, a bootstrap that takes 40 minutes
# leaves 3h20m, not 4h.
#
# Secrets are never baked in here. They arrive through the SSM-free channel
# documented in launch-checkpoint section 12: a run-scoped secret is fetched from
# an operator-hosted HTTPS endpoint whose URL and bearer token are supplied as
# kernel arguments at launch (kept out of Git and out of cloud-init logs by
# being passed as --instance-initiated... no: see README). If no secret channel is
# available the run does not start the app and reports DEGRADED instead.
#
# Everything this script learns is written under /var/lib/capacity-run/ so the
# readiness endpoint can serve it without anything reading the guest directly.

set -euo pipefail

RUN_ID="${RUN_ID:-cap-20261109t0800z-a7f3}"
RUN_DIR=/var/lib/capacity-run
LOG="$RUN_DIR/bootstrap.log"
LIFETIME_SECONDS="${LIFETIME_SECONDS:-14400}"   # 4 hours
APP_DIR=/opt/assetflow
COMMIT="${ASSETFLOW_COMMIT:-}"

mkdir -p "$RUN_DIR"
exec > >(tee -a "$LOG") 2>&1

say() { printf '[bootstrap] %s\n' "$*"; }
fail() { printf '[bootstrap][FATAL] %s\n' "$*"; echo "failed: $*" > "$RUN_DIR/bootstrap-status"; exit 1; }

echo running > "$RUN_DIR/bootstrap-status"

# ---------------------------------------------------------------- 1. deadline
# Deadline from launch time, not from now.
say "== deadline =="
# IMDSv2 token, then the instance's own launch time.
TOKEN="$(curl -fsS -X PUT 'http://169.254.169.254/latest/api/token' \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)"
if [ -z "${TOKEN:-}" ]; then
    fail "no IMDSv2 token: cannot read launch time, so cannot compute a launch-based deadline"
fi

LAUNCH_TIME="$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" \
    'http://169.254.169.254/latest/meta-data/instance/lifecycle' 2>/dev/null || true)"

# lifecycle gives the launch time; fall back to the documented tag if absent.
if [ -z "${LAUNCH_TIME:-}" ]; then
    LAUNCH_TIME="$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" \
        'http://169.254.169.254/latest/meta-data/tags/instance/LaunchTime' 2>/dev/null || true)"
fi
if [ -z "${LAUNCH_TIME:-}" ]; then
    fail "cannot determine launch time: a now-relative deadline would silently extend the run"
fi

NOW="$(date +%s)"
LAUNCH_EPOCH="$(date -d "$LAUNCH_TIME" +%s 2>/dev/null || echo '')"
if [ -z "$LAUNCH_EPOCH" ]; then
    fail "unparseable launch time: $LAUNCH_TIME"
fi

REMAINING=$(( LAUNCH_EPOCH + LIFETIME_SECONDS - NOW ))
if [ "$REMAINING" -le 0 ]; then
    # Bootstrap itself consumed the whole window: terminate rather than linger.
    fail "deadline already passed during bootstrap (remaining ${REMAINING}s)"
fi
say "launch=$LAUNCH_TIME remaining=${REMAINING}s"

echo "$LAUNCH_EPOCH" > "$RUN_DIR/launch-epoch"
echo "$(( LAUNCH_EPOCH + LIFETIME_SECONDS ))" > "$RUN_DIR/deadline-epoch"

# The deadline is armed with `shutdown`, and the instance was launched with
# InstanceInitiatedShutdownBehavior=terminate, so this TERMINATES the instance
# and deletes its root volume. It is a transient timer: a *reboot* clears it, so
# section 7 re-arms it on every boot and records that it did.
systemd-run --on-active="${REMAINING}s" --unit=capacity-deadline \
    --description="capacity run deadline (launch-based)" /sbin/shutdown -h now
sleep 1
systemctl is-active capacity-deadline.timer > "$RUN_DIR/timer-state" || true
systemctl show capacity-deadline.timer -p NextElapseUSecMonotonic \
    > "$RUN_DIR/timer-next-elapse" 2>/dev/null || true
say "deadline timer: $(cat "$RUN_DIR/timer-state" 2>/dev/null || echo unknown)"

# ---------------------------------------------------------------- 2. packages
say "== packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git openssl jq python3 >/dev/null
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

# 1 GB of RAM is not enough for the image build; swap is required, not optional.
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
fi

# ---------------------------------------------------------------- 3. code
say "== code =="
if [ -z "$COMMIT" ]; then
    fail "ASSETFLOW_COMMIT not supplied: refusing to deploy an unpinned checkout"
fi
rm -rf "$APP_DIR"
git clone -q https://github.com/BhaveshSab/assetflow "$APP_DIR"
git -C "$APP_DIR" checkout -q "$COMMIT" || fail "cannot check out pinned commit $COMMIT"
echo "$(git -C "$APP_DIR" rev-parse HEAD)" > "$RUN_DIR/deployed-commit"

# ---------------------------------------------------------------- 4. secrets
# Secrets arrive from the operator, never from this file.
if [ -z "${SECRET_URL:-}" ] || [ -z "${SECRET_TOKEN:-}" ]; then
    echo "degraded: no secret channel" > "$RUN_DIR/bootstrap-status"
    say "no SECRET_URL/SECRET_TOKEN: app will not start, readiness reports degraded"
    exit 0
fi
curl -fsS -H "Authorization: Bearer $SECRET_TOKEN" "$SECRET_URL" -o "$RUN_DIR/run.env" \
    || fail "secret fetch failed"
chmod 600 "$RUN_DIR/run.env"

# ---------------------------------------------------------------- 5. deploy
say "== deploy =="
cd "$APP_DIR"
set -a; . "$RUN_DIR/run.env"; set +a
export RUN_ID
docker compose -f infra/docker-compose.yml up -d --build || fail "compose up failed"

# Synthetic fixtures, scoped to this run id so nothing is shared.
docker compose -f infra/docker-compose.yml exec -T api \
    npm run seed:loadtest -- --run-id "$RUN_ID" --users "${FIXTURE_USERS:-30}" \
    > "$RUN_DIR/seed.log" 2>&1 || fail "fixture seeding failed"

# ---------------------------------------------------------------- 6. evidence
say "== evidence endpoint =="
mkdir -p "$RUN_DIR/evidence"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -keyout "$RUN_DIR/evidence.key" -out "$RUN_DIR/evidence.crt" \
    -subj "/CN=capacity-run" >/dev/null 2>&1 || fail "cert generation failed"
chmod 600 "$RUN_DIR/evidence.key"

# The bearer token is generated here and printed ONLY to the log the operator
# fetches over TLS; it is never in Git and never in the instance tags.
head -c 48 /dev/urandom | base64 | tr -d '\n' > "$RUN_DIR/evidence.token"
chmod 600 "$RUN_DIR/evidence.token"

cat > /etc/systemd/system/capacity-evidence.service <<UNIT
[Unit]
Description=capacity run evidence endpoint
After=network-online.target
[Service]
Environment=EVIDENCE_DIR=$RUN_DIR
EnvironmentFile=$RUN_DIR/evidence.token.env
ExecStart=/usr/bin/python3 $APP_DIR/infra/scripts/evidence_server.py --cert $RUN_DIR/evidence.crt --key $RUN_DIR/evidence.key --port 8443
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
printf 'EVIDENCE_TOKEN=%s\n' "$(cat "$RUN_DIR/evidence.token")" > "$RUN_DIR/evidence.token.env"
chmod 600 "$RUN_DIR/evidence.token.env"
systemctl daemon-reload
systemctl enable --now capacity-evidence.service || fail "evidence endpoint failed to start"

# ---------------------------------------------------------------- 7. metrics
say "== host metrics =="
cat > /etc/systemd/system/capacity-metrics.service <<UNIT
[Unit]
Description=capacity run host metrics
After=network-online.target
[Service]
ExecStart=/bin/bash $APP_DIR/infra/capacity-run/collect-metrics.sh
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now capacity-metrics.service || fail "metrics collector failed to start"

# ---------------------------------------------------------------- 8. ready
echo ready > "$RUN_DIR/bootstrap-status"
say "bootstrap complete"

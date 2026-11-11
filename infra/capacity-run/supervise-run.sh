#!/usr/bin/env bash
#
# Supervise one capacity run from outside the instance.
#
# WHY THIS IS NOT A FOREGROUND WAIT
# Holding a step open until the instance terminates is not supervision: it waits
# four hours, observes nothing, and then reports that the box is gone. The run
# has to be watched while it is happening - status polled from outside, readiness
# probed, evidence retained - so a failure at minute 20 is known at minute 20 and
# the reason survives the instance.
#
# Three things run concurrently:
#   * the detached watchdog, which terminates the exact instance id at the
#     deadline and writes a heartbeat proving it is alive;
#   * the off-host status poller, which retains timestamped redacted snapshots
#     from the moment the early endpoint answers;
#   * this script, which follows the run, probes readiness, and stops at the
#     Stage 3 boundary. It does not load test.
#
# Usage
#   supervise-run.sh --instance ID --host HOST --pubkey DIR --state-dir DIR [--max-minutes N]
set -uo pipefail

INSTANCE_ID=""
HOST_NAME="capacity-run.test"
TRUST_DIR=""
STATE_DIR=""
MAX_MINUTES="${MAX_MINUTES:-240}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
    case "$1" in
        --instance) INSTANCE_ID="${2:?}"; shift 2 ;;
        --host) HOST_NAME="${2:?}"; shift 2 ;;
        --trust-dir) TRUST_DIR="${2:?}"; shift 2 ;;
        --state-dir) STATE_DIR="${2:?}"; shift 2 ;;
        --max-minutes) MAX_MINUTES="${2:?}"; shift 2 ;;
        *) echo "supervise: unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$INSTANCE_ID" ] && [ -n "$TRUST_DIR" ] && [ -n "$STATE_DIR" ] || {
    echo "supervise: --instance, --trust-dir and --state-dir are required" >&2; exit 2; }
mkdir -p "$STATE_DIR/snapshots"
: "${EVIDENCE_TOKEN:?EVIDENCE_TOKEN must be set to poll the status endpoint}"

. "$HERE/aws-context.sh"

say() { printf '[supervise] %s\n' "$*"; }

# ---- resolve the instance's public address -------------------------------
pub_ip() {
    cap_aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null
}
state() {
    cap_aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null
}

IP=$(pub_ip)
[ -n "$IP" ] && [ "$IP" != "None" ] || { say "instance $INSTANCE_ID has no public address"; exit 1; }
say "instance $INSTANCE_ID at $IP"

# ---- start the watchdog detached, then prove it is alive -----------------
WATCHDOG_LOG="$STATE_DIR/watchdog.log"
WATCHDOG_DIR="$STATE_DIR/watchdog"
# setsid + nohup: it must not die with this shell.
setsid nohup env AWS_PROFILE="$CAP_PROFILE" AWS_REGION="$CAP_REGION" \
    WATCHDOG_STATE_DIR="$WATCHDOG_DIR" \
    bash "$HERE/operator-watchdog.sh" "$INSTANCE_ID" 14400 >> "$WATCHDOG_LOG" 2>&1 &
WD_PID=$!
say "watchdog started pid $WD_PID"

# A started process is not a running watchdog. Wait for the heartbeat file to
# appear and then to advance, which is the only evidence it is doing anything.
HEARTBEAT="$WATCHDOG_DIR/heartbeat"
for _ in $(seq 1 30); do
    [ -s "$HEARTBEAT" ] && break
    sleep 1
done
if [ ! -s "$HEARTBEAT" ]; then
    say "watchdog produced no heartbeat; continuing but recording it as failed"
    printf 'no-heartbeat' > "$STATE_DIR/watchdog-status"
else
    FIRST=$(cat "$HEARTBEAT")
    sleep 62
    SECOND=$(cat "$HEARTBEAT" 2>/dev/null || echo "$FIRST")
    if [ "$SECOND" != "$FIRST" ]; then
        say "watchdog heartbeat advancing ($FIRST -> $SECOND)"
        printf 'advancing' > "$STATE_DIR/watchdog-status"
    else
        say "watchdog heartbeat NOT advancing ($FIRST)"
        printf 'stalled' > "$STATE_DIR/watchdog-status"
    fi
    if kill -0 "$WD_PID" 2>/dev/null; then
        say "watchdog pid $WD_PID is alive"
    else
        say "watchdog pid $WD_PID is NOT alive"
    fi
fi

# ---- P3: prove termination of this instance would be permitted -----------
# The dry-run is against the instance that exists NOW. There is no
# "fifth-instance P3" before a fifth instance exists, and saying otherwise would
# be a claim about a resource that has no identity yet.
if cap_aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --dry-run 2>"$STATE_DIR/p3.err"; then
    printf 'dry-run-accepted' > "$STATE_DIR/p3"
    say "P3: terminate dry-run accepted for $INSTANCE_ID"
elif grep -q 'DryRunOperation' "$STATE_DIR/p3.err"; then
    printf 'dry-run-accepted' > "$STATE_DIR/p3"
    say "P3: terminate dry-run accepted for $INSTANCE_ID"
else
    printf 'dry-run-refused' > "$STATE_DIR/p3"
    say "P3: terminate dry-run REFUSED for $INSTANCE_ID"
    sed 's/Encoded authorization.*//' "$STATE_DIR/p3.err" >&2
fi

# ---- poll status from outside, retaining snapshots -----------------------
POLL_LOG="$STATE_DIR/poll.log"
( setsid nohup bash "$HERE/poll-status.sh" \
    --host "$HOST_NAME" --address "$IP" --port 8443 \
    --ca "$TRUST_DIR/ca.crt" --token "$EVIDENCE_TOKEN" \
    --outdir "$STATE_DIR/snapshots" --duration $(( MAX_MINUTES * 60 )) \
    > "$POLL_LOG" 2>&1 & )
say "status poller started"

# ---- follow the run until it becomes ready or dies -----------------------
START=$(date +%s)
DEADLINE=$(( START + MAX_MINUTES * 60 ))
LAST_STAGE=""
STAGE_SEEN=""
LAST_SNAPSHOT=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    S=$(state)
    case "$S" in
        terminated|shutting-down)
            say "instance reached $S"
            break
            ;;
    esac

    # Read the newest retained snapshot rather than trusting a live curl: the
    # poller is what has the certificate and the token, and its files are the
    # evidence that survives this process.
    NEWEST=$(ls -1t "$STATE_DIR/snapshots" 2>/dev/null | head -1 || true)
    if [ -n "$NEWEST" ] && [ "$NEWEST" != "$LAST_SNAPSHOT" ]; then
        LAST_SNAPSHOT="$NEWEST"
        mv "$STATE_DIR/snapshots/$NEWEST" "$STATE_DIR/snapshots/received-$NEWEST" 2>/dev/null || true
        STAGE=$(jq -r '.stage // "unknown"' "$STATE_DIR/snapshots/received-$NEWEST" 2>/dev/null || echo unknown)
        READY=$(jq -r '.application_ready // false' "$STATE_DIR/snapshots/received-$NEWEST" 2>/dev/null || echo false)
        if [ "$STAGE" != "$LAST_STAGE" ]; then
            say "stage: $STAGE (application_ready=$READY)"
            LAST_STAGE="$STAGE"
            STAGE_SEEN="$STAGE"
        fi
        if [ "$READY" = "true" ]; then
            say "application reports ready at stage $STAGE"
            printf 'ready' > "$STATE_DIR/app-ready"
            break
        fi
    fi
    sleep 15
done

# ---- readiness from the client side, with the real certificate -----------
READY_LOG="$STATE_DIR/readiness.log"
if curl -sS --max-time 20 --resolve "$HOST_NAME:8443:$IP" \
        --cacert "$TRUST_DIR/ca.crt" \
        "https://$HOST_NAME:8443/api/health/ready" -o "$STATE_DIR/ready.body" \
        -w 'http_code=%{http_code}\n' > "$READY_LOG" 2>&1; then
    CODE=$(sed -n 's/^http_code=//p' "$READY_LOG")
    say "readiness over verified TLS: HTTP $CODE"
    printf '%s' "$CODE" > "$STATE_DIR/ready-code"
else
    say "readiness probe failed"
    printf 'failed' > "$STATE_DIR/ready-code"
fi

say "stage last seen: ${STAGE_SEEN:-none}"
say "stopping at the Stage 3 boundary; no load test was run"
[ -d "$STATE_DIR/snapshots" ] && say "retained $(ls -1 "$STATE_DIR/snapshots" 2>/dev/null | wc -l) snapshots"
exit 0

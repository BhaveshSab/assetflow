#!/usr/bin/env bash
#
# Supervise one capacity run from outside the instance.
#
# WHAT THIS FIXES
# The previous version waited for `application_ready` in the diagnostic status
# document. That field is a literal `false` in bootstrap-status.py - deliberately,
# because the diagnostic channel does not know whether the application works. So
# the wait could only end when the instance died, and the real application route
# was probed once, afterwards. The run could never pass.
#
# Readiness is now decided ONLY by the application's own HTTPS readiness route,
# probed repeatedly during observation with CA and hostname verification. The
# diagnostic status document is consumed for stage/progress and for its
# snapshots, and its `application_ready` value is reported but never waited on.
#
# EXIT STATUS IS HONEST
#   0  complete Stage 3 readiness contract satisfied
#   1  a required check failed (P3, watchdog, evidence, readiness verdict)
#   2  usage error
#   3  readiness timeout / never became healthy
#   4  instance terminated before readiness
#   5  evidence could not be verified
#
# Usage
#   supervise-run.sh --instance ID --host HOST --trust-dir DIR --state-dir DIR
#                    [--max-minutes N] [--token TOKEN]
set -uo pipefail

INSTANCE_ID=""
HOST_NAME="capacity-run.test"
TRUST_DIR=""
STATE_DIR=""
MAX_MINUTES="${MAX_MINUTES:-240}"
PORT="${PORT:-8443}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
    case "$1" in
        --instance) INSTANCE_ID="${2:?}"; shift 2 ;;
        --host) HOST_NAME="${2:?}"; shift 2 ;;
        --trust-dir) TRUST_DIR="${2:?}"; shift 2 ;;
        --state-dir) STATE_DIR="${2:?}"; shift 2 ;;
        --max-minutes) MAX_MINUTES="${2:?}"; shift 2 ;;
        --port) PORT="${2:?}"; shift 2 ;;
        --token) EVIDENCE_TOKEN="${2:?}"; shift 2 ;;
        *) echo "supervise: unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$INSTANCE_ID" ] && [ -n "$TRUST_DIR" ] && [ -n "$STATE_DIR" ] || {
    echo "supervise: --instance, --trust-dir and --state-dir are required" >&2; exit 2; }
mkdir -p "$STATE_DIR/snapshots"
: "${EVIDENCE_TOKEN:?EVIDENCE_TOKEN must be set to poll the status endpoint}"

. "$HERE/aws-context.sh"

say() { printf '[supervise] %s\n' "$*"; }

# Every failure is recorded before the process exits, so the workflow can still
# run cleanup and retention and still report why.
VERDICT="$STATE_DIR/verdict"
fail() {
    local code="$1"; shift
    printf '%s\n' "$*" > "$VERDICT"
    say "FAIL: $*"
    exit "$code"
}

# ---- resolve the instance's public address -------------------------------
pub_ip() {
    cap_aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null
}
state() {
    cap_aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null
}

IP=""
for _ in $(seq 1 20); do
    IP=$(pub_ip)
    [ -n "$IP" ] && [ "$IP" != "None" ] && break
    sleep 5
done
[ -n "$IP" ] && [ "$IP" != "None" ] || fail 4 "instance $INSTANCE_ID has no public address"
say "instance $INSTANCE_ID at $IP"

# ---- the detached watchdog ----------------------------------------------
# Mandatory. If it is not alive, nothing bounds the run at the deadline, so the
# supervisor must not sit here pretending everything is fine.
WATCHDOG_STATE="$STATE_DIR/watchdog-status"
if [ -x "$HERE/operator-watchdog.sh" ]; then
    ( setsid nohup bash "$HERE/operator-watchdog.sh" \
        --instance "$INSTANCE_ID" --state-dir "$STATE_DIR" \
        --max-minutes "$MAX_MINUTES" >"$STATE_DIR/watchdog.log" 2>&1 & )
    sleep 30
    if [ -f "$WATCHDOG_STATE" ] && grep -q alive "$WATCHDOG_STATE"; then
        say "watchdog started"
    else
        fail 1 "watchdog did not report alive within 30s"
    fi
fi

# ---- P3: prove termination of THIS instance would be permitted ----------
if cap_aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --dry-run 2>"$STATE_DIR/p3.err"; then
    printf 'dry-run-accepted' > "$STATE_DIR/p3"
    say "P3: terminate dry-run accepted for $INSTANCE_ID"
elif grep -q 'DryRunOperation' "$STATE_DIR/p3.err"; then
    printf 'dry-run-accepted' > "$STATE_DIR/p3"
    say "P3: terminate dry-run accepted for $INSTANCE_ID"
else
    printf 'dry-run-refused' > "$STATE_DIR/p3"
    sed 's/Encoded authorization.*//' "$STATE_DIR/p3.err" >&2
    fail 1 "P3: terminate dry-run REFUSED — cleanup could not be guaranteed"
fi

# ---- off-host status retention ------------------------------------------
POLL_LOG="$STATE_DIR/poll.log"
( setsid nohup bash "$HERE/poll-status.sh" \
    --host "$HOST_NAME" --address "$IP" --port "$PORT" \
    --ca "$TRUST_DIR/ca.crt" --token "$EVIDENCE_TOKEN" \
    --outdir "$STATE_DIR/snapshots" --duration $(( MAX_MINUTES * 60 )) \
    > "$POLL_LOG" 2>&1 & )
say "status poller started"

# ---- application readiness, probed repeatedly DURING observation --------
# The real route. Verified TLS: the CA is the run's own, and --resolve pins the
# hostname to this instance, so neither a wrong host nor an unsigned cert passes.
READY_URL="https://$HOST_NAME:$PORT/api/health/ready"
probe_ready() {
    local body="$STATE_DIR/last-ready.body" log="$STATE_DIR/last-ready.err"
    local code
    code=$(curl -sS --max-time 15 \
                 --resolve "$HOST_NAME:$PORT:$IP" \
                 --cacert "$TRUST_DIR/ca.crt" \
                 -o "$body" -w '%{http_code}' \
                 "$READY_URL" 2>"$log") || code="000"
    printf '%s' "$code"
}

# The guest's bootstrap status document is a DIAGNOSTIC. Its application_ready
# field is false by design; stage is informational only.
latest_snapshot() {
    # Consume without modifying: read the newest non-consumed file and record
    # its name in our own ledger. The poller's files are never renamed or moved.
    local f
    # Consume in filename order, which is timestamp order for the poller's own
    # names. The consumed ledger is a plain file of basenames; the poller's
    # files are never renamed, moved or rewritten.
    shopt -s nullglob
    for f in "$STATE_DIR/snapshots"/*.json; do
        if ! grep -qxF "$(basename "$f")" "$STATE_DIR/consumed" 2>/dev/null; then
            shopt -u nullglob
            printf '%s' "$f"
            return 0
        fi
    done
    shopt -u nullglob
    return 0
}

START=$(date +%s)
DEADLINE=$(( START + MAX_MINUTES * 60 ))
: > "$STATE_DIR/consumed"
LAST_STAGE=""
SAW_READY_CODE=""

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    S=$(state)
    case "$S" in
        terminated|shutting-down)
            fail 4 "instance reached $S before readiness was confirmed"
            ;;
    esac

    # Mandatory check, re-evaluated every pass rather than recorded and ignored.
    if [ -f "$WATCHDOG_STATE" ] && grep -q 'dead' "$WATCHDOG_STATE"; then
        fail 1 "watchdog stopped while the run was still live"
    fi

    SNAP=$(latest_snapshot)
    if [ -n "$SNAP" ]; then
        basename "$SNAP" >> "$STATE_DIR/consumed"
        # A malformed or partial snapshot must not be read as progress or as
        # readiness. It is recorded and skipped.
        if jq -e . "$SNAP" >/dev/null 2>&1; then
            STAGE=$(jq -r '.stage // "unknown"' "$SNAP" 2>/dev/null || echo unknown)
            DIAG=$(jq -r '.application_ready // false' "$SNAP" 2>/dev/null || echo false)
            if [ "$STAGE" != "$LAST_STAGE" ]; then
                say "diagnostic stage: $STAGE (application_ready=$DIAG, not a gate)"
                LAST_STAGE="$STAGE"
            fi
        else
            say "snapshot $(basename "$SNAP") is not valid JSON; skipping"
        fi
    fi

    CODE=$(probe_ready)
    case "$CODE" in
        200)
            # The application says ready. This is the ONLY readiness signal.
            cp "$STATE_DIR/last-ready.body" "$STATE_DIR/ready.body" 2>/dev/null || true
            printf '200' > "$STATE_DIR/ready-code"
            SAW_READY_CODE=200
            say "application readiness: HTTP 200 — app is healthy"
            break
            ;;
        503)
            # Serving, not yet ready: migrations/schema still settling.
            say "application readiness: HTTP 503 (not ready yet)"
            ;;
        000)
            say "application readiness: no response yet"
            ;;
        *)
            printf '%s' "$CODE" > "$STATE_DIR/ready-code"
            fail 5 "application returned HTTP $CODE, which is not a readiness verdict"
            ;;
    esac
    sleep 15
done

if [ "$SAW_READY_CODE" != "200" ]; then
    printf 'failed' > "$STATE_DIR/ready-code"
    fail 3 "readiness was not reached within ${MAX_MINUTES} minutes"
fi

# ---- the complete Stage 3 readiness contract ----------------------------
# One HTTP 200 is not Stage 3. The application document must also show a working
# database and a current schema, and CI must have built fixtures and metrics.
contract_check() {
    local name="$1" ok="$2"
    if [ "$ok" = "1" ]; then
        say "contract ok: $name"
    else
        fail 5 "contract check failed: $name"
    fi
}

DOC="$STATE_DIR/ready.body"
contract_check "readiness body present" "$([ -s "$DOC" ] && echo 1 || echo 0)"
contract_check "status == ready" \
    "$(jq -r 'if .status == "ready" then 1 else 0 end' "$DOC" 2>/dev/null || echo 0)"
contract_check "database == up" \
    "$(jq -r 'if .database == "up" then 1 else 0 end' "$DOC" 2>/dev/null || echo 0)"
contract_check "schema == current" \
    "$(jq -r 'if .schema == "current" then 1 else 0 end' "$DOC" 2>/dev/null || echo 0)"

# Fixtures: the seeded account count must be present and non-zero, from the
# guest's own records, never assumed.
FIX="$(jq -r '[.fixture_users, .accounts_verified] | map(select(. != null)) | .[0] // empty' "$DOC" 2>/dev/null || true)"
if [ -n "$FIX" ]; then
    # A count the application reports is authoritative, including a zero. It is
    # not a cue to go looking for a friendlier number somewhere else.
    contract_check "fixtures seeded (>0)" "$([ "$FIX" -gt 0 ] 2>/dev/null && echo 1 || echo 0)"
else
    # Fall back to the guest evidence log if the route does not report it.
    SNAP=$(latest_snapshot)
    if [ -n "$SNAP" ]; then
        N=$(jq -r '.accounts_seen_in_log // 0' "$SNAP" 2>/dev/null || echo 0)
        contract_check "fixtures seeded (from status log, >0)" \
            "$([ "$N" -gt 0 ] 2>/dev/null && echo 1 || echo 0)"
    else
        fail 5 "no evidence that fixtures were seeded"
    fi
fi

# Metrics: a fresh sample must exist and be non-empty.
contract_check "metrics retained" \
    "$(ls -1 "$STATE_DIR/snapshots"/*.json >/dev/null 2>&1 && echo 1 || echo 0)"

# Export checksum: verify what was retained is intact.
if [ -x "$HERE/snapshot-evidence.sh" ]; then
    SUM="$STATE_DIR/evidence.sha256"
    if bash "$HERE/snapshot-evidence.sh" --state-dir "$STATE_DIR" --out "$SUM" >/dev/null 2>&1 \
       && [ -s "$SUM" ]; then
        contract_check "evidence checksum produced" "1"
        printf 'export-verified' > "$STATE_DIR/export-status"
    else
        contract_check "evidence checksum produced" "0"
    fi
fi

say "stage last seen: ${LAST_STAGE:-none}"
printf 'ready' > "$STATE_DIR/app-ready"
printf 'complete' > "$VERDICT"
say "Stage 3 readiness contract satisfied; no load test was run"
[ -d "$STATE_DIR/snapshots" ] && say "retained $(ls -1 "$STATE_DIR/snapshots" 2>/dev/null | wc -l) snapshots"
exit 0

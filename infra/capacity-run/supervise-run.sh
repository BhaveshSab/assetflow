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
#
# The invocation and the liveness checks follow the watchdog's REAL contract:
# positional <instance-id> [lifetime-seconds] and WATCHDOG_STATE_DIR for its
# state directory. Liveness is proven, not assumed: the recorded pid must exist
# and the heartbeat must be numeric, recent and advancing. The seventh attempt
# died here because the supervisor invented flags the watchdog has never
# parsed (--instance/--state-dir/--max-minutes) and then waited 30 seconds for
# a file (watchdog-status containing "alive") the watchdog has never written.
#
# The lifetime is the instance's own four-hour lifetime, measured by the
# watchdog from the actual AWS LaunchTime. It is deliberately NOT derived from
# --max-minutes: the supervisor's observation timeout and the instance's
# lifetime are different controls.
WATCHDOG_LIFETIME="${WATCHDOG_LIFETIME:-14400}"
WATCHDOG_MAX_AGE="${WATCHDOG_MAX_AGE:-150}"
WATCHDOG_PID_FILE="$STATE_DIR/watchdog-pid"
WATCHDOG_HEARTBEAT="$STATE_DIR/heartbeat"
WATCHDOG_LOG="$STATE_DIR/watchdog.log"
WATCHDOG_STATE="$STATE_DIR/watchdog-status"
case "$WATCHDOG_LIFETIME" in ''|*[!0-9]*)
    fail 2 "watchdog lifetime must be a number of seconds, got '$WATCHDOG_LIFETIME'" ;;
esac
case "$WATCHDOG_MAX_AGE" in ''|*[!0-9]*)
    fail 2 "watchdog max age must be a number of seconds, got '$WATCHDOG_MAX_AGE'" ;;
esac

# Empty output means every observed signal is healthy. A problem is returned on
# stdout AND mirrored into watchdog-status, so the workflow's outcome record
# always shows the last observed state. The heartbeat must be a number whose
# age is within WATCHDOG_MAX_AGE (two watchdog poll cycles plus slack) and not
# implausibly in the future; a stalled or forged heartbeat is a failure.
watchdog_problem() {
    local pid v age problem=""
    pid=$(cat "$WATCHDOG_PID_FILE" 2>/dev/null || true)
    case "$pid" in
        ''|*[!0-9]*) problem="no recorded watchdog pid" ;;
        *)  kill -0 "$pid" 2>/dev/null || problem="watchdog process $pid is gone" ;;
    esac
    if [ -z "$problem" ]; then
        v=$(cat "$WATCHDOG_HEARTBEAT" 2>/dev/null || true)
        case "$v" in
            ''|*[!0-9]*) problem="heartbeat is missing or not numeric" ;;
            *)
                age=$(( $(date -u +%s) - v ))
                if [ "$age" -gt "$WATCHDOG_MAX_AGE" ]; then
                    problem="heartbeat is ${age}s stale (pid $pid)"
                elif [ "$age" -lt -300 ]; then
                    problem="heartbeat is $((- age))s in the future"
                fi
                ;;
        esac
    fi
    if [ -n "$problem" ]; then
        printf '%s\n' "$problem" > "$WATCHDOG_STATE"
        printf '%s' "$problem"
        return 1
    fi
    printf 'alive pid=%s heartbeat_age=%ss' "$pid" "$age" > "$WATCHDOG_STATE"
    return 0
}

if [ ! -x "$HERE/operator-watchdog.sh" ]; then
    fail 1 "operator-watchdog.sh is missing or not executable; nothing would bound the run at the deadline"
fi
: > "$WATCHDOG_LOG"
( WATCHDOG_STATE_DIR="$STATE_DIR" setsid nohup bash "$HERE/operator-watchdog.sh" \
    "$INSTANCE_ID" "$WATCHDOG_LIFETIME" >>"$WATCHDOG_LOG" 2>&1 & echo $! >"$WATCHDOG_PID_FILE" )
# Bounded startup polling, not a fixed sleep followed by one file check: the
# pid must exist, and the heartbeat must appear, be numeric and be recent.
STARTED=""
for _ in $(seq 1 15); do
    if watchdog_problem >/dev/null 2>&1; then STARTED=1; break; fi
    sleep 2
done
if [ -z "$STARTED" ]; then
    fail 1 "watchdog did not become alive within 30s ($(watchdog_problem 2>/dev/null || true)); its output: $(tail -c 400 "$WATCHDOG_LOG" 2>/dev/null | tr '\n' ';')"
fi
say "watchdog started (pid $(cat "$WATCHDOG_PID_FILE"), lifetime ${WATCHDOG_LIFETIME}s from LaunchTime)"

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
    --ca "$TRUST_DIR/tls.crt" --token "$EVIDENCE_TOKEN" \
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
                 --cacert "$TRUST_DIR/tls.crt" \
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
    if ! P=$(watchdog_problem); then
        fail 1 "watchdog stopped while the run was still live: $P"
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

# Export checksum: verify what THIS supervisor retained is intact, so the
# verdict can be audited after the run. This is LOCAL snapshot integrity only -
# it says the runner's own copies were not corrupted in place. It is NOT the
# guest-evidence export, which is proven separately below.
SUM="$STATE_DIR/evidence.sha256"
if find "$STATE_DIR/snapshots" -type f -name '*.json' -print0 2>/dev/null \
     | sort -z | xargs -0 -r sha256sum > "$SUM" 2>/dev/null && [ -s "$SUM" ]; then
    contract_check "evidence checksum produced" "1"
else
    contract_check "evidence checksum produced" "0"
fi

# ---- guest evidence: authenticated download, verified against the guest's ----
# own digest. The publisher records the digest of the archive it built; the
# status document carries that digest over the authenticated status channel;
# only then is the archive itself downloaded through the edge and verified
# against it by the real export client. export-evidence.sh exits 0 ONLY when
# the downloaded bytes match the expected digest over verified TLS with the
# bearer token - an unverified or failed download can never report success.
# A missing digest in every retained snapshot is a missing contract, not a skip.
EXPORTER=""
[ -x "$HERE/../scripts/export-evidence.sh" ] && EXPORTER="$HERE/../scripts/export-evidence.sh"
[ -z "$EXPORTER" ] && [ -x "$HERE/export-evidence.sh" ] && EXPORTER="$HERE/export-evidence.sh"
GUEST_NAME=""; GUEST_SHA=""
if [ -n "$EXPORTER" ]; then
    for f in $(ls -1r "$STATE_DIR"/snapshots/*.json 2>/dev/null || true); do
        n=$(jq -r '.evidence_snapshot.name // ""' "$f" 2>/dev/null || true)
        s=$(jq -r '.evidence_snapshot.sha256 // ""' "$f" 2>/dev/null || true)
        printf '%s' "$s" | grep -Eq '^[0-9a-f]{64}$' || continue
        case "$n" in snapshot-*.tar.gz) ;; *) continue ;; esac
        GUEST_NAME="$n"; GUEST_SHA="$s"; break
    done
fi
GUEST_EXPORT_NOTE=""
if [ -z "$EXPORTER" ]; then
    contract_check "guest evidence exported and checksum-verified" "0"
    GUEST_EXPORT_NOTE="export client not found"
elif [ -z "$GUEST_NAME" ] || [ -z "$GUEST_SHA" ]; then
    contract_check "guest evidence exported and checksum-verified" "0"
    GUEST_EXPORT_NOTE="no guest-supplied digest in any retained snapshot (scanned $(ls -1 "$STATE_DIR"/snapshots/*.json 2>/dev/null | wc -l) snapshots)"
else
    GUEST_OUT="$STATE_DIR/guest-evidence.tar.gz"
    : > "$STATE_DIR/guest-export.log"
    if EVIDENCE_TOKEN="$EVIDENCE_TOKEN" \
       EVIDENCE_CA="$TRUST_DIR/tls.crt" \
       EXPORT_RESOLVE="$HOST_NAME:$PORT:$IP" \
       EXPORT_ATTEMPTS="${EXPORT_ATTEMPTS:-3}" EXPORT_TIMEOUT=120 \
       bash "$EXPORTER" "https://$HOST_NAME:$PORT" "$GUEST_NAME" "$GUEST_SHA" \
           "$GUEST_OUT" >>"$STATE_DIR/guest-export.log" 2>&1 \
       && [ -s "$GUEST_OUT" ]; then
        contract_check "guest evidence exported and checksum-verified" "1"
        printf 'guest-verified archive=%s sha256=%s bytes=%s\n' \
            "$GUEST_NAME" "$GUEST_SHA" "$(wc -c < "$GUEST_OUT")" > "$STATE_DIR/guest-export.txt"
    else
        # A failure must name its reason: the export log is the evidence, and a
        # bounded tail of it reaches the supervisor output the workflow records.
        contract_check "guest evidence exported and checksum-verified" "0"
        GUEST_EXPORT_NOTE="export failed or unverified: $(tail -c 300 "$STATE_DIR/guest-export.log" 2>/dev/null | tr '\n' ';')"
    fi
fi
[ -n "$GUEST_EXPORT_NOTE" ] && { printf '%s\n' "$GUEST_EXPORT_NOTE" > "$STATE_DIR/guest-export.txt"; warn "guest export: $GUEST_EXPORT_NOTE"; }

say "stage last seen: ${LAST_STAGE:-none}"
printf 'ready' > "$STATE_DIR/app-ready"
printf 'complete' > "$VERDICT"
say "Stage 3 readiness contract satisfied; no load test was run"
[ -d "$STATE_DIR/snapshots" ] && say "retained $(ls -1 "$STATE_DIR/snapshots" 2>/dev/null | wc -l) snapshots"
exit 0

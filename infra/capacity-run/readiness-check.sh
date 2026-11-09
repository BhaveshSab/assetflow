#!/bin/bash
#
# Readiness check for the capacity run, over HTTPS, against the REAL server
# contract.
#
# evidence_server.py serves exactly one thing: /evidence/<name>.tar.gz. It has no
# per-file endpoints, so this script fetches a snapshot tarball and inspects the
# files inside it. The earlier version requested /bootstrap-status directly, which
# the server answers with 404 - that check could never have passed.
#
# Trust: the certificate must chain to the pinned CA and the destination must match
# its SAN. -k is never used and is not an option here.
#
# Fail closed throughout: absent, malformed, empty or stale measurements FAIL. A
# missing metric is not a healthy zero.
set -uo pipefail

HOST="${1:?usage: readiness-check.sh <host> [port]}"
PORT="${2:-443}"
: "${EVIDENCE_TOKEN:?EVIDENCE_TOKEN must be set}"
: "${EVIDENCE_CA:?EVIDENCE_CA must be set (no insecure fallback)}"
EXPECTED_COMMIT="${EXPECTED_COMMIT:?EXPECTED_COMMIT must be set}"
MAX_STALE_SECONDS="${MAX_STALE_SECONDS:-10}"
MAX_MEM_PCT="${MAX_MEM_PCT:-70}"
ARCHIVE="${ARCHIVE:-snapshot-latest.tar.gz}"

fail=0
ok()  { printf '  PASS  %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "readiness for https://${HOST}:${PORT}/evidence/${ARCHIVE}"

# ------------------------------------------------------------ fetch archive
if ! curl --fail --silent --show-error --max-time 30 \
        --cacert "$EVIDENCE_CA" \
        --header "Authorization: Bearer ${EVIDENCE_TOKEN}" \
        --output "$WORK/evidence.tar.gz" \
        "https://${HOST}:${PORT}/evidence/${ARCHIVE}"; then
    bad "could not fetch /evidence/${ARCHIVE} (TLS trust, hostname or auth failed)"
    echo; echo "READINESS FAILED"; exit 1
fi
ok "archive fetched over verified TLS"

if ! tar -tzf "$WORK/evidence.tar.gz" >/dev/null 2>&1; then
    bad "archive is not a readable tarball"
    echo; echo "READINESS FAILED"; exit 1
fi
tar -xzf "$WORK/evidence.tar.gz" -C "$WORK" || { bad "archive extract failed"; exit 1; }

# The archive must not contain the run directory's secrets.
for forbidden in run.env tls.key evidence.token.txt; do
    if [ -e "$WORK/$forbidden" ] || [ -e "$WORK/./$forbidden" ]; then
        bad "archive leaked $forbidden"
    fi
done
[ "$fail" -eq 0 ] && ok "archive contains no private key, token or run.env"

# ---------------------------------------------------------------- status
read_field() { cat "$WORK/$1" 2>/dev/null | tr -d '\r\n'; }

status="$(read_field bootstrap-status)"
case "$status" in
    ready)    ok "bootstrap status = ready" ;;
    degraded|failed*|running|'') bad "bootstrap status = '${status:-<absent>}'" ;;
    *)        bad "bootstrap status unexpected: $status" ;;
esac

# ---------------------------------------------------------------- commit
deployed="$(read_field deployed-commit)"
expected="$(read_field expected-commit)"
if [ -z "$deployed" ]; then
    bad "deployed-commit absent"
elif [ "$deployed" != "$EXPECTED_COMMIT" ]; then
    bad "deployed commit $deployed != expected $EXPECTED_COMMIT"
elif [ -n "$expected" ] && [ "$expected" != "$EXPECTED_COMMIT" ]; then
    bad "guest expected-commit $expected != $EXPECTED_COMMIT"
else
    ok "deployed commit matches the pin: $deployed"
fi

# ---------------------------------------------------------------- deadline
deadline="$(read_field deadline-epoch)"
now=$(date +%s)
case "$deadline" in
    ''|*[!0-9]*) bad "deadline-epoch absent or malformed: '${deadline}'" ;;
    *)
        if [ "$deadline" -gt "$now" ]; then
            ok "deadline is a future absolute instant ($(( deadline - now ))s remaining)"
        else
            bad "deadline already passed"
        fi ;;
esac

timer_state="$(read_field deadline-timer-state)"
[ "$timer_state" = "active" ] && ok "deadline timer unit active" \
                              || bad "deadline timer not active: '${timer_state:-<absent>}'"

guard="$(read_field deadline-status)"
case "$guard" in
    ok*) ok "deadline guard ran and reports remaining time" ;;
    *)   bad "deadline guard status: '${guard:-<absent>}'" ;;
esac

# ---------------------------------------------------------------- app health
health="$(read_field app-health)"
[ "$health" = "healthy" ] && ok "application health endpoint answered" \
                          || bad "app-health: '${health:-<absent>}'"

users="$(read_field fixture-users)"
case "$users" in
    ''|*[!0-9]*) bad "fixture-users absent: seed result unproven" ;;
    *) if [ "$users" -ge 200 ]; then ok "fixtures seeded for $users accounts"
       else bad "fixture-users is $users, expected at least 200"; fi ;;
esac

# ---------------------------------------------------------------- metrics
if [ ! -s "$WORK/host-metrics.jsonl" ]; then
    bad "host-metrics.jsonl absent or empty"
else
    last="$(tail -1 "$WORK/host-metrics.jsonl")"
    verdict="$(printf '%s' "$last" | python3 -c '
import json, sys, datetime
raw = sys.stdin.read().strip()
if not raw:
    print("EMPTY"); raise SystemExit
try:
    d = json.loads(raw)
except Exception:
    print("MALFORMED"); raise SystemExit
pct = d.get("mem_used_pct")
if pct is None:
    print("NO_MEMORY"); raise SystemExit
ts = d.get("ts")
if not ts:
    print("NO_TS"); raise SystemExit
try:
    t = datetime.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
except Exception:
    print("BAD_TS"); raise SystemExit
age = (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()
if age > 10:
    print(f"STALE {int(age)}"); raise SystemExit
if d.get("errors", 0) > 0:
    print("PARTIAL"); raise SystemExit
print(f"OK {pct} {int(age)}")
' 2>/dev/null)"

    case "$verdict" in
        OK\ *) set -- $verdict
               if [ "$2" -le "$MAX_MEM_PCT" ]; then
                   ok "host memory ${2}% <= ${MAX_MEM_PCT}% (sample ${3}s old)"
               else
                   bad "host memory ${2}% exceeds ${MAX_MEM_PCT}% gate"
               fi ;;
        STALE*)  bad "metrics are stale: ${verdict#STALE }s old (limit ${MAX_STALE_SECONDS}s)" ;;
        PARTIAL) bad "metrics report partial collection errors" ;;
        *)       bad "metrics unusable: ${verdict}" ;;
    esac
fi

echo
if [ "$fail" -ne 0 ]; then
    echo "READINESS FAILED - do not start load; terminate the instance"
    exit 1
fi
echo "READINESS PASSED"
echo "NOTE: this proves the deadline guard is installed and running now. It does"
echo "not prove the timer will still fire after an unusual failure; the operator"
echo "watchdog is the independent second line."

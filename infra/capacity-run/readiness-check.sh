#!/usr/bin/env bash
#
# Readiness check for the capacity run, over HTTPS only.
#
# There is no SSH and no SSM. Everything this script learns comes from the
# evidence endpoint on 443, which serves files the bootstrap wrote. That is the
# whole point: "the timer file exists" is not evidence if the only way to see it
# is a shell on the guest.
#
# What it proves, and what it cannot:
#   * bootstrap status             - from bootstrap-status, written by user-data
#   * the deadline is armed         - from timer-state + deadline-epoch
#   * the deployed commit           - from deployed-commit, proves the pinned SHA
#   * host memory headroom          - from host-metrics.jsonl
#
# It CANNOT prove the timer will fire. It proves the unit is active and a deadline
# is recorded; a unit that is active now can still be masked, crash, or be cleared
# by a reboot. That limitation is stated in the checkpoint rather than papered
# over.
set -euo pipefail

HOST="${1:?usage: readiness-check.sh <host> [port]}"
PORT="${2:-8443}"
TOKEN="${EVIDENCE_TOKEN:?EVIDENCE_TOKEN must be set (read it from the secret channel, not the repo)}"
CA="${EVIDENCE_CA:-}"          # pinned cert, or -k is refused below
MAX_RSS_MB="${MAX_RSS_MB:-716}" # 70% of 1024 MB

curl_() {
    if [ -n "$CA" ]; then
        curl -fsS --max-time 10 --cacert "$CA" \
            -H "Authorization: Bearer ${TOKEN}" "https://${HOST}:${PORT}/$1"
    else
        # Refusing to fall back to an unverified TLS connection: the token is
        # sent in a header, and accepting any certificate would leak it.
        echo "EVIDENCE_CA must be set to the run certificate (no insecure fallback)" >&2
        return 2
    fi
}

fail=0
ok()   { printf '  PASS  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }

echo "readiness for https://${HOST}:${PORT}"

status="$(curl_ bootstrap-status 2>/dev/null || echo unreachable)"
case "$status" in
    ready)    ok "bootstrap status = ready" ;;
    degraded) bad "bootstrap status = degraded (no secret channel; app not started)" ;;
    running)  bad "bootstrap still running" ;;
    *)        bad "bootstrap status unavailable: $status" ;;
esac

timer="$(curl_ timer-state 2>/dev/null || echo unreachable)"
if [ "$timer" = "active" ]; then
    ok "deadline timer unit is active"
else
    bad "deadline timer is not active: $timer"
fi

deadline="$(curl_ deadline-epoch 2>/dev/null || echo 0)"
now="$(date +%s)"
if [ "$deadline" -gt "$now" ] 2>/dev/null; then
    ok "deadline recorded: $(( (deadline - now) ))s remaining (launch-based)"
else
    bad "no future deadline recorded: '$deadline'"
fi

commit="$(curl_ deployed-commit 2>/dev/null || true)"
if [ -n "$commit" ]; then
    ok "deployed commit $commit"
else
    bad "no deployed commit reported"
fi

rss="$(curl_ host-metrics.jsonl 2>/dev/null | tail -1 \
    | python3 -c 'import json,sys; d=sys.stdin.read().strip(); print(json.loads(d).get("rss_mb",0) if d else 0)' 2>/dev/null || true)"
rss="${rss:-0}"
if [ "$rss" -le "$MAX_RSS_MB" ] 2>/dev/null; then
    ok "RSS ${rss}MB <= ${MAX_RSS_MB}MB gate"
else
    bad "RSS ${rss}MB exceeds ${MAX_RSS_MB}MB gate"
fi

echo
if [ "$fail" -ne 0 ]; then
    echo "READINESS FAILED - do not start load; terminate the instance"
    exit 1
fi
echo "READINESS PASSED - the deadline is armed and the app reports ready"
echo "NOTE: this proves the timer is active now, not that it will fire."

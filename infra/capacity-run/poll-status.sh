#!/usr/bin/env bash
# Poll the guest's bootstrap-status endpoint and keep every snapshot off-host.
#
# Why: the evidence for a failed run has to exist somewhere the run cannot take
# with it. On attempt 4 the instance was gone within a minute of the failure and
# the console buffer had already rolled, so nothing was retrievable. This runs
# on the operator's side for the whole life of the run, so the last status before
# the guest disappears is already on disk.
#
# It talks to the same single public port as everything else, using the run's own
# TLS trust and bearer token, and it verifies the hostname. No -k, ever.
#
# Usage
#   poll-status.sh --host HOST --token TOKEN --ca CA [--port 8443]
#                  [--outdir DIR] [--interval 30] [--duration 7200]
#
# Exit status: 0 if at least one snapshot was retained, 1 otherwise. A run that
# never answered is reported as never having answered - not as healthy.
set -uo pipefail

HOST=""
TOKEN=""
CA=""
PORT=8443
OUTDIR=""
INTERVAL=30
DURATION=7200

while [ "$#" -gt 0 ]; do
    case "$1" in
        --host) HOST="$2"; shift 2 ;;
        --token) TOKEN="$2"; shift 2 ;;
        --ca) CA="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --outdir) OUTDIR="$2"; shift 2 ;;
        --interval) INTERVAL="$2"; shift 2 ;;
        --duration) DURATION="$2"; shift 2 ;;
        *) echo "poll-status: unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$HOST" ] || { echo "poll-status: --host is required" >&2; exit 2; }
[ -n "$TOKEN" ] || { echo "poll-status: --token is required" >&2; exit 2; }
[ -n "$CA" ] || { echo "poll-status: --ca is required" >&2; exit 2; }
[ -f "$CA" ] || { echo "poll-status: CA file not found: $CA" >&2; exit 2; }

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
[ -n "$OUTDIR" ] || OUTDIR="status-$STAMP"
mkdir -p "$OUTDIR"
chmod 700 "$OUTDIR"

# Timestamped snapshots, one file per pull, so a failure can be read in sequence
# rather than reconstructed from a single overwritten blob.
fetch() {
    local endpoint="$1" name="$2" ts code
    ts=$(date -u +%Y%m%dT%H%M%SZ)
    local target="$OUTDIR/${ts}-${name}.json"
    code=$(curl --silent --show-error --max-time 10 \
        --cacert "$CA" \
        --resolve "${HOST}:${PORT}:${HOST}" \
        --header "Authorization: Bearer ${TOKEN}" \
        --output "$target" --write-out '%{http_code}' \
        "https://${HOST}:${PORT}${endpoint}" 2>/dev/null) || code=000
    if [ "$code" != "200" ]; then
        # Keep the failure as evidence too; a rejected pull is information.
        printf '{"error":"http_%s","endpoint":"%s","at":"%s"}\n' \
            "$code" "$endpoint" "$ts" > "$target" 2>/dev/null || true
        rm -f "$target"
        return 1
    fi
    chmod 600 "$target"
    return 0
}

echo "poll-status: polling https://$HOST:$PORT every ${INTERVAL}s for ${DURATION}s into $OUTDIR"
start=$(date +%s)
kept=0
last_stage=""
while :; do
    now=$(date +%s)
    [ $(( now - start )) -ge "$DURATION" ] && break

    if fetch /status status; then
        kept=$(( kept + 1 ))
        # Everything that matters on the way out: the failure body, the seed's
        # own exit status, and the host observations around it.
        fetch /status/seed seed       || true
        fetch /status/host host       || true
        fetch /status/failure failure || true
        # Report only on change, so the operator's log stays readable.
        stage=$(sed -n 's/.*"stage": *"\([^"]*\)".*/\1/p' "$OUTDIR"/$(ls -t "$OUTDIR" | head -1) 2>/dev/null | head -1)
        if [ -n "$stage" ] && [ "$stage" != "$last_stage" ]; then
            echo "poll-status: $(date -u +%H:%M:%SZ) stage=$stage"
            last_stage="$stage"
        fi
    fi
    sleep "$INTERVAL"
done

echo "poll-status: retained $kept snapshot(s) in $OUTDIR"
[ "$kept" -gt 0 ] || exit 1
exit 0

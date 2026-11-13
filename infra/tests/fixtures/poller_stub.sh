#!/usr/bin/env bash
# Test poller stand-in. Writes snapshots whose application_ready is ALWAYS false,
# which is exactly what the real diagnostic endpoint reports. The status document
# carries fixture_users from the guest's own record (bootstrap-status.py reads
# the count the seed wrote); the sixteenth and seventeenth attempts showed the
# supervisor's fallback must read THIS field, not a field nothing produces.
# When the fake guest has published an archive, the snapshot carries its digest
# the way the real status document does (evidence_snapshot), so the supervisor's
# export contract is exercised against the real export client. The meta file is
# written by the fake guest at startup, which races a fast runner: wait for it,
# bounded.
OUT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --outdir) OUT="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[ -n "$OUT" ] || exit 1
mkdir -p "$OUT"
EV='"evidence_snapshot": null'
if [ -n "${GUEST_META:-}" ]; then
    for _ in $(seq 1 40); do
        [ -s "$GUEST_META" ] && break
        sleep 0.5
    done
    [ -s "$GUEST_META" ] && EV="\"evidence_snapshot\": $(cat "$GUEST_META")"
fi
# The real poller writes a fresh snapshot every interval and runs until the
# supervisor stops it; a single file can be consumed by an earlier contract
# step and leave nothing for a later one, which no real run can hit. Each
# cycle writes the four records the real poller writes, with the REAL naming
# (<ts>-status.json, -seed, -host, -failure): only the -status record carries
# the status fields. The eighteenth attempt failed exactly because the
# supervisor's newest-snapshot lookup globbed *.json and read a -seed record -
# this stub is the regression test for that.
n=1
while :; do
    ts=$(date -u +%Y%m%dT%H%M%S)
    printf '{"stage":"bootstrap","application_ready":false,"fixture_users":%s,%s}\n' \
        "${STUB_FIXTURE_USERS:-200}" "$EV" > "$OUT/${ts}-status.json"
    printf '{"seeded":true}\n' > "$OUT/${ts}-seed.json"
    printf '{"load":0.1}\n' > "$OUT/${ts}-host.json"
    n=$((n + 1))
    sleep 2
done

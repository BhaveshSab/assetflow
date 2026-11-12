#!/usr/bin/env bash
# Test poller stand-in. Writes snapshots whose application_ready is ALWAYS false,
# which is exactly what the real diagnostic endpoint reports. When the fake guest
# has published an archive, the snapshot carries its digest the way the real
# status document does (evidence_snapshot), so the supervisor's export contract
# is exercised against the real export client.
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
if [ -n "${GUEST_META:-}" ] && [ -s "$GUEST_META" ]; then
    EV="\"evidence_snapshot\": $(cat "$GUEST_META")"
fi
printf '{"stage":"bootstrap","application_ready":false,"accounts_seen_in_log":200,%s}\n' "$EV" > "$OUT/0001.json"

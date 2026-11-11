#!/usr/bin/env bash
# Test poller stand-in. Writes snapshots whose application_ready is ALWAYS false,
# which is exactly what the real diagnostic endpoint reports.
OUT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --outdir) OUT="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[ -n "$OUT" ] || exit 1
mkdir -p "$OUT"
printf '{"stage":"bootstrap","application_ready":false,"accounts_seen_in_log":200}\n' > "$OUT/0001.json"

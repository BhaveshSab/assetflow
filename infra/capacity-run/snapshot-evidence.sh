#!/bin/bash
#
# Publish a fresh evidence tarball for the existing evidence_server contract.
#
# The server serves exactly one thing: /evidence/<name>.tar.gz from the evidence
# directory. It has no per-file endpoints, so readiness and evidence export both
# work by fetching a tarball - not by requesting /bootstrap-status directly.
#
# Two defects fixed here, both found by the integration harness:
#
#  1. The archive was built inside the evidence directory it was archiving, so tar
#     returned 1 ("file changed as we read it") and no snapshot was ever published.
#     The staging directory is now outside, and the trap removes it.
#  2. `ls -1t ... | tail | while` under pipefail exits non-zero when nothing
#     matches. Retention is now guarded.
#
# The archive deliberately contains ONLY the evidence directory. The run directory
# also holds run.env, the TLS private key and the token; the server is pointed at
# the evidence directory alone so those can never be served.
set -uo pipefail

RUN_DIR="${RUN_DIR:-/var/lib/assetflow-capacity}"
EVIDENCE_DIR="$RUN_DIR/evidence"
KEEP="${SNAPSHOT_KEEP:-20}"

cd "$EVIDENCE_DIR" || exit 1

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME="snapshot-${STAMP}.tar.gz"

STAGE=$(mktemp -d) || exit 1
trap 'rm -rf "$STAGE"' EXIT

if ! tar -czf "$STAGE/$NAME" \
        --exclude='snapshot-*.tar.gz' \
        --exclude='.snapshot-*' \
        -C "$EVIDENCE_DIR" . ; then
    echo "snapshot: tar failed" >&2
    exit 1
fi

mv -f "$STAGE/$NAME" "$EVIDENCE_DIR/$NAME" || exit 1

# A stable alias the operator can request without knowing the timestamp. The
# server's allow-list requires a name ending .tar.gz, so this is a real copy.
cp -f "$EVIDENCE_DIR/$NAME" "$EVIDENCE_DIR/snapshot-latest.tar.gz" || exit 1

# Bounded retention, tolerant of an empty match.
if [ -n "$(ls -1t "$EVIDENCE_DIR"/snapshot-2*.tar.gz 2>/dev/null)" ]; then
    ls -1t "$EVIDENCE_DIR"/snapshot-2*.tar.gz 2>/dev/null \
        | tail -n +$(( KEEP + 1 )) \
        | while read -r old; do rm -f "$old"; done
fi

exit 0

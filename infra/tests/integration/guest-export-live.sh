#!/usr/bin/env bash
#
# The REAL guest-evidence export path, end to end:
#
#   snapshot-evidence.sh (guest publisher)
#     -> .snapshot-latest.meta (digest computed on the guest, over its bytes)
#     -> bootstrap-status.py /status through the REAL nginx edge (8443)
#        carries that digest to the runner over the authenticated status channel
#     -> export-evidence.sh downloads the archive through the SAME edge
#        (/evidence/ -> the real evidence_server.py on 9443) and verifies the
#        downloaded bytes against the digest it did NOT compute itself.
#
# This is the distinction Stage 3 must prove: a checksum over runner-side
# retained snapshots is local integrity only. Here the expected digest is
# supplied independently by the guest, the bytes come over verified TLS with a
# bearer token, and a tampered digest is refused rather than reported as
# success. Nothing is stubbed except the network address (localhost) and AWS
# (not involved at all).
set -uo pipefail

REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
cd "$REPO" || exit 1

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }
want() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want $2, got $3)"; fi; }

command -v docker >/dev/null 2>&1 || { printf 'SKIP  docker missing; the real edge cannot run here\n'; exit 0; }
docker info >/dev/null 2>&1 || { printf 'SKIP  docker unusable; the real edge cannot run here\n'; exit 0; }
command -v jq >/dev/null 2>&1 || { for d in /mnt/c/Users/bhave/tools "$HOME/bin"; do [ -x "$d/jq" ] && PATH="$d:$PATH" && break; done; }
command -v jq >/dev/null 2>&1 || { printf 'SKIP  jq missing\n'; exit 0; }

W=$(mktemp -d)
CONTAINER=capacity-edge-export-check
PIDS=()
cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1
    for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
    rm -rf "$W"
}
trap cleanup EXIT

# ------------------------------------------------------- TLS: the guest shape
# Self-signed leaf (generate-trust.sh): server cert, upstream anchor and client
# CA are the same file. Mirror it exactly.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
    -keyout "$W/leaf.key" -out "$W/leaf.pem" -subj "/CN=capacity-run.test" \
    -addext "subjectAltName=DNS:capacity-run.test" >/dev/null 2>&1 \
    || { bad "certificate generation failed"; exit 1; }

TOKEN=$(openssl rand -hex 32)
HOST=capacity-run.test
RES="--resolve $HOST:8443:127.0.0.1"

# Guest layout: the same paths the real run uses.
RUN_DIR="$W/run"; EVIDENCE_DIR="$RUN_DIR/evidence"
mkdir -p "$EVIDENCE_DIR" "$W/guest/capacity-run" "$W/proxy" "$W/nginxlog"
cp "$W/leaf.pem" "$W/guest/capacity-run/tls.crt"
cp "$W/leaf.key" "$W/guest/capacity-run/tls.key"
chmod 600 "$W/guest/capacity-run/tls.key"
# Realistic evidence content, and a secret that must never travel.
printf 'ready\n' > "$EVIDENCE_DIR/bootstrap-status"
printf '%s\n' "$REPO" > "$EVIDENCE_DIR/deployed-commit"
printf 'POSTGRES_PASSWORD=super-secret-pw\n' > "$RUN_DIR/run.env"

# ------------------------------------- real publisher, status and evidence services
RUN_DIR="$RUN_DIR" bash infra/capacity-run/snapshot-evidence.sh || { bad "the publisher failed"; exit 1; }

python3 infra/capacity-run/bootstrap-status.py \
    --cert "$W/leaf.pem" --key "$W/leaf.key" --token "$TOKEN" \
    --run-dir "$RUN_DIR" --port 9444 --host 127.0.0.1 > "$W/status.log" 2>&1 &
PIDS+=("$!")
EVIDENCE_DIR="$EVIDENCE_DIR" EVIDENCE_TOKEN="$TOKEN" \
    python3 infra/scripts/evidence_server.py \
    --cert "$W/leaf.pem" --key "$W/leaf.key" --port 9443 --host 127.0.0.1 > "$W/evidence.log" 2>&1 &
PIDS+=("$!")
sleep 1

# The FULL edge config: this is what serves /evidence/ after the handoff.
cp infra/capacity-run/edge/edge.conf "$W/proxy/edge.conf"
cp infra/capacity-run/edge/nginx.conf "$W/proxy/nginx.conf"
docker run -d --name "$CONTAINER" --network host \
    -v "$W/proxy/edge.conf:/etc/capacity-edge/edge.conf:ro" \
    -v "$W/proxy/nginx.conf:/etc/capacity-edge/nginx.conf:ro" \
    -v "$W/guest/capacity-run:/etc/capacity-run:ro" \
    -v "$W/nginxlog:/var/log/nginx" \
    nginx:1.27-alpine \
    nginx -c /etc/capacity-edge/nginx.conf -g 'daemon off;' >/dev/null 2>&1 \
    || { bad "the nginx container failed to start"; exit 1; }
sleep 2

# ============================================================ 1. the publisher
ARCHIVE="$(ls -1 "$EVIDENCE_DIR"/snapshot-2*.tar.gz 2>/dev/null | head -1)"
[ -n "$ARCHIVE" ] && ok "the publisher published a timestamped archive" || bad "no archive published"
META="$EVIDENCE_DIR/.snapshot-latest.meta"
[ -s "$META" ] && ok "the publisher recorded its digest" || bad "no publisher digest recorded"
PUB_SHA="$(jq -r '.sha256 // ""' "$META" 2>/dev/null || true)"
PUB_NAME="$(jq -r '.name // ""' "$META" 2>/dev/null || true)"
ACTUAL_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
want "the recorded digest matches the published bytes" "$ACTUAL_SHA" "$PUB_SHA"
case "$(basename "$ARCHIVE")" in "$PUB_NAME") ok "the recorded name is the immutable timestamped archive";; *) bad "recorded name is not the timestamped archive: $PUB_NAME";; esac
if tar -tzf "$ARCHIVE" 2>/dev/null | grep -q '\.snapshot-latest\.meta'; then
    bad "the digest file must not travel inside the archive"
else
    ok "the digest file does not travel inside the archive"
fi
if tar -tzf "$ARCHIVE" 2>/dev/null | grep -q 'run\.env'; then
    bad "run secrets reached the archive"
else
    ok "run secrets never reached the archive"
fi

# ============================================ 2. the digest over the status channel
CODE=$(curl -sS $RES --cacert "$W/leaf.pem" -H "Authorization: Bearer $TOKEN" \
    -o "$W/status.json" -w '%{http_code}' "https://$HOST:8443/status" 2>/dev/null || echo 000)
want "the status document answers through the real edge" "200" "$CODE"
STATUS_SHA="$(jq -r '.evidence_snapshot.sha256 // ""' "$W/status.json" 2>/dev/null || true)"
STATUS_NAME="$(jq -r '.evidence_snapshot.name // ""' "$W/status.json" 2>/dev/null || true)"
want "the status channel supplies the guest's digest" "$PUB_SHA" "$STATUS_SHA"
want "the status channel supplies the archive name" "$PUB_NAME" "$STATUS_NAME"
# The runner must not trust a malformed digest either.
if jq -e '.evidence_snapshot == null' "$W/status.json" >/dev/null 2>&1; then :; fi
rm -f "$META"
CODE=$(curl -sS $RES --cacert "$W/leaf.pem" -H "Authorization: Bearer $TOKEN" \
    -o "$W/status2.json" -w '%{http_code}' "https://$HOST:8443/status" 2>/dev/null || echo 000)
jq -e '.evidence_snapshot == null' "$W/status2.json" >/dev/null 2>&1 \
    && ok "an absent publisher record is null, never invented" \
    || bad "absent publisher record was not null: $(cat "$W/status2.json" 2>/dev/null | head -c 200)"

# ================================= 3. the verified download against that digest
OUT="$W/exported.tar.gz"
rm -f "$OUT"
EVIDENCE_TOKEN="$TOKEN" EVIDENCE_CA="$W/leaf.pem" \
EXPORT_RESOLVE="$HOST:8443:127.0.0.1" \
    infra/scripts/export-evidence.sh "https://$HOST:8443" "$STATUS_NAME" "$STATUS_SHA" "$OUT" \
    > "$W/export.log" 2>&1
want "the export client verified the download" "0" "$?"
[ -s "$OUT" ] && ok "the verified archive is in place" || bad "no verified archive"
DOWN_SHA="$(sha256sum "$OUT" 2>/dev/null | awk '{print $1}')"
want "the downloaded bytes match the guest-supplied digest" "$PUB_SHA" "$DOWN_SHA"

# ======================================= 4. a tampered digest is never success
rm -f "$OUT"
# Flip the first hex character deterministically, whatever it is.
case "$STATUS_SHA" in f*) TAMPERED="e${STATUS_SHA:1}";; *) TAMPERED="f${STATUS_SHA:1}";; esac
EVIDENCE_TOKEN="$TOKEN" EVIDENCE_CA="$W/leaf.pem" \
EXPORT_RESOLVE="$HOST:8443:127.0.0.1" EXPORT_ATTEMPTS=1 \
    infra/scripts/export-evidence.sh "https://$HOST:8443" "$STATUS_NAME" "$TAMPERED" "$OUT" \
    > "$W/tamper.log" 2>&1
RC=$?
[ "$RC" -ne 0 ] && ok "a tampered digest fails the export (rc=$RC)" || bad "a tampered digest exported successfully"
[ "$RC" = "75" ] && ok "the tampered export is reported unverified (75)" || bad "unexpected rc for tampered digest: $RC"
[ ! -s "$OUT" ] && ok "no verified archive is left behind by a tampered export" || bad "a tampered export left bytes in place"

# ===================================================== 5. no token, no evidence
rm -f "$OUT"
EVIDENCE_CA="$W/leaf.pem" \
EXPORT_RESOLVE="$HOST:8443:127.0.0.1" EXPORT_ATTEMPTS=1 \
    env -u EVIDENCE_TOKEN infra/scripts/export-evidence.sh "https://$HOST:8443" "$STATUS_NAME" "$STATUS_SHA" "$OUT" \
    > "$W/notoken.log" 2>&1
RC=$?
[ "$RC" = "2" ] && ok "a missing token is a usage error, not a fetch" || bad "missing token rc: $RC"

printf '\n---- guest-export-live: %s (%d pass, %d fail) ----\n' \
    "$([ "$FAIL" -eq 0 ] && echo PASS || echo FAIL)" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0

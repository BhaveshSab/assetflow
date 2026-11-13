#!/bin/bash
#
# Start the application stack and gate readiness on the real health endpoint.
#
# Why this exists: the thirteenth attempt died at the readiness gate by
# design - migrate-db.sh brings up only postgres and redis, and the only
# other `up -d` in user-data.sh restarts nginx AFTER this gate, so nothing
# had ever started the api. The gate probed a container that did not exist
# for the whole 90-iteration window. This lives in the repo rather than the
# payload for the same reason as early-edge.sh: EC2 caps user-data at 16 KiB
# and the payload was within a few hundred bytes of the limit.
#
# Environment:
#   APP_DIR       checkout root (the pinned commit)
#   EVIDENCE_DIR  run evidence directory
#   COMPOSE       the full `docker compose --env-file ... -f ...` command
#   TLS_SRC       directory holding tls.crt / tls.key (default /etc/capacity-run)
set -uo pipefail

APP_DIR="${APP_DIR:?APP_DIR must be set}"
EVIDENCE_DIR="${EVIDENCE_DIR:?EVIDENCE_DIR must be set}"
COMPOSE="${COMPOSE:?COMPOSE must be set}"
TLS_SRC="${TLS_SRC:-/etc/capacity-run}"

fail() { printf '%s\n' "app-health: $1" >&2; exit 1; }

# The app nginx serves TLS from ./certs (mounted at /etc/letsencrypt). CI
# supplies the run certificate the same way; without it nginx cannot start.
mkdir -p "$APP_DIR/infra/certs/live/assetflow" || fail "cannot create the certs directory"
cp "$TLS_SRC/tls.crt" "$APP_DIR/infra/certs/live/assetflow/fullchain.pem" \
    || fail "cannot install the certificate"
install -m 600 "$TLS_SRC/tls.key" "$APP_DIR/infra/certs/live/assetflow/privkey.pem" \
    || fail "cannot install the certificate key"

# Start exactly what CI starts (`up -d api nginx`); postgres, redis and the
# migration arrive via depends_on and are already up from the migration gate.
timeout 900 $COMPOSE up -d api nginx > "$EVIDENCE_DIR/stack-up.log" 2>&1 \
    || fail "the application stack failed to start (see stack-up.log)"

for i in $(seq 1 90); do
    if $COMPOSE exec -T api node -e \
        "fetch('http://127.0.0.1:4000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
        >/dev/null 2>&1; then
        echo healthy > "$EVIDENCE_DIR/app-health"
        break
    fi
    [ "$i" -eq 90 ] && {
        $COMPOSE ps > "$EVIDENCE_DIR/stack-ps.txt" 2>&1 || true
        $COMPOSE logs --tail 80 api > "$EVIDENCE_DIR/api-readiness.log" 2>&1 || true
        fail "application readiness never passed (see api-readiness.log)"
    }
    sleep 5
done

# A health flag alone is not a working application: also fetch through the
# application's own nginx, which is the upstream the single-port edge will
# proxy to. Recorded for the evidence; a failure here does not exit non-zero
# because the readiness gate above is the contract, and the edge check is
# diagnostic.
EDGE_CODE=$($COMPOSE exec -T api node -e \
    "fetch('http://nginx/api/health/ready').then(r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log(0);process.exit(0)})" \
    2>/dev/null | tr -d '[:space:]')
printf '%s\n' "${EDGE_CODE:-0}" > "$EVIDENCE_DIR/edge-health"

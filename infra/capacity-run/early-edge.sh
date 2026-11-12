#!/usr/bin/env bash
#
# Publish the bootstrap diagnostic channel on the one approved port, 8443.
#
# WHY THIS EXISTS AS A SEPARATE FILE
# The status service starts on loopback 9444 very early, but the full edge does
# not arrive until the end of the run, so the guest was previously unreachable
# from outside for the whole of the build, migration and seeding work - exactly
# the window in which a failure happens. This publishes /status on 8443 before
# any of that work, and publishes nothing else.
#
# THE HONEST WINDOW: this needs docker, which the packages stage installs. The
# channel is therefore reachable once packages and the nginx image are
# available, and NOT before. It is not pre-package observability, and neither
# this comment nor the caller may be reworded to claim that it is.
#
# It lives here rather than inline because user-data is capped at 16 KiB and the
# template was already within ~100 bytes of that limit. The caller fetches this
# file from the pinned commit and runs it.
#
# Called with: EXPECTED_COMMIT, CAPACITY_HOSTNAME, EVIDENCE_TOKEN,
#              EVIDENCE_DIR, and the die/say/stage_* helpers in scope.
set -euo pipefail

: "${EXPECTED_COMMIT:?}" "${CAPACITY_HOSTNAME:?}" "${EVIDENCE_TOKEN:?}" "${EVIDENCE_DIR:?}"
MODE="${1:-start}"

EDGE_SRC="https://raw.githubusercontent.com/BhaveshSab/assetflow/$EXPECTED_COMMIT/infra/capacity-run/edge"
mkdir -p /etc/capacity-run-proxy
curl -fsSL "$EDGE_SRC/edge-early.conf" -o /etc/capacity-run-proxy/edge.conf \
    || die "cannot fetch the early edge config"
curl -fsSL "$EDGE_SRC/nginx.conf" -o /etc/capacity-run-proxy/nginx.conf \
    || die "cannot fetch the edge nginx.conf"

# The certificate in /etc/capacity-run is already written. It is mounted
# read-only, and no other host path is exposed to the container.
docker rm -f capacity-edge >/dev/null 2>&1 || true
docker run -d --name capacity-edge --restart unless-stopped --network host \
    -v /etc/capacity-run:/etc/capacity-run:ro \
    -v /etc/capacity-run-proxy:/etc/capacity-edge:ro \
    -v /var/log/nginx:/var/log/nginx \
    nginx:1.27-alpine \
    nginx -c /etc/capacity-edge/nginx.conf -g 'daemon off;' \
    || die "the early diagnostics edge failed to start"

# Reachable means reachable over verified TLS from the port the client uses,
# with the token the operator will actually send - not merely "the container is
# running".
CODE=000
for _ in $(seq 1 30); do
    CODE=$(curl -sS --max-time 5 --cacert /etc/capacity-run/tls.crt \
        --resolve "$CAPACITY_HOSTNAME:8443:127.0.0.1" \
        -H "Authorization: Bearer $EVIDENCE_TOKEN" \
        -o /dev/null -w '%{http_code}' \
        "https://$CAPACITY_HOSTNAME:8443/status" 2>/dev/null || echo 000)
    [ "$CODE" = "200" ] && break
    sleep 1
done
printf '%s' "$CODE" > "$EVIDENCE_DIR/early-status-http"
[ "$CODE" = "200" ] || die "early diagnostics unreachable on 8443 (HTTP $CODE)"
say "diagnostics reachable externally on 8443 (HTTP $CODE)"

if [ "$MODE" != "switch" ]; then
    exit 0
fi

# ------------------------------------------------------------------ switch
# The caller has already installed the full edge.conf. Hand the SAME container
# over to it: one 8443 listener exists for the whole run, so there is no window
# in which the port is unbound and no second listener to collide with. A
# recreate is only a fallback for a container that cannot reload.
if docker exec capacity-edge nginx -t -c /etc/capacity-edge/nginx.conf >/dev/null 2>&1 \
   && docker exec capacity-edge nginx -s reload >/dev/null 2>&1; then
    say "edge: reloaded the running container onto full routing"
else
    say "edge: reload unavailable, recreating the container on the same port"
    docker rm -f capacity-edge >/dev/null 2>&1 || true
    docker run -d --name capacity-edge --restart unless-stopped --network host \
        -v /etc/capacity-run-proxy:/etc/capacity-edge:ro \
        -v /etc/capacity-run:/etc/capacity-run:ro \
        -v /var/log/nginx:/var/log/nginx \
        nginx:1.27-alpine \
        nginx -c /etc/capacity-edge/nginx.conf -g 'daemon off;' \
        || die "single-port edge failed to start"
fi

# All three routes are verified before ready is declared. /status keeps working:
# the diagnostic channel is not a bootstrap luxury, it is what makes a later
# failure retrievable.
for i in $(seq 1 30); do
    A=$(curl -sk -o /dev/null -w '%{http_code}' \
        "https://$CAPACITY_HOSTNAME:8443/api/health/ready" || echo 0)
    E=$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $EVIDENCE_TOKEN" \
        "https://$CAPACITY_HOSTNAME:8443/evidence/snapshot-latest.tar.gz" || echo 0)
    D=$(curl -sS -o /dev/null -w '%{http_code}' --cacert /etc/capacity-run/tls.crt \
        --resolve "$CAPACITY_HOSTNAME:8443:127.0.0.1" \
        -H "Authorization: Bearer $EVIDENCE_TOKEN" \
        "https://$CAPACITY_HOSTNAME:8443/status" || echo 0)
    [ "$A" = "200" ] && [ "$E" = "200" ] && [ "$D" = "200" ] && break
    [ "$i" -eq 30 ] && die "edge cannot reach app ($A), evidence ($E) or status ($D)"
    sleep 2
done
printf 'status=%s app=%s evidence=%s\n' "$D" "$A" "$E" > "$EVIDENCE_DIR/edge-routing"
say "edge: /status -> 9444, /api -> 8080, /evidence -> 9443 (all 200)"

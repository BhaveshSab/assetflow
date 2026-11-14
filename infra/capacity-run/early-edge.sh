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
# Modes:
#   early-edge.sh          start: fetch the early config, run the container,
#                          verify /status answers on 8443.
#   early-edge.sh switch   hand the SAME running container over to the full
#                          routing config the caller has installed, then verify
#                          all three routes. Nothing is fetched in this mode:
#                          re-fetching the early config would overwrite the full
#                          one and reload the edge backwards onto diagnostics.
#
# Called with: EXPECTED_COMMIT, CAPACITY_HOSTNAME, EVIDENCE_TOKEN, EVIDENCE_DIR.
set -euo pipefail

# die and say are normally provided by the caller (user-data defines them).
# Fall back to plain implementations so this script also runs standalone in the
# integration tests.
type die >/dev/null 2>&1 || die() {
    printf 'fatal: %s\n' "$*" >&2
    # This script runs inside the bootstrap payload, whose own die trap writes
    # the failure summary; a die HERE bypasses that trap, so the one-liner
    # never reached /status/failure and the twentieth attempt's switch failure
    # was only visible on the console. Record it for the diagnostic channel.
    printf '%s\n' "edge $MODE failed: $*" > "$EVIDENCE_DIR/failure-summary" 2>/dev/null || true
    exit 1
}
type say >/dev/null 2>&1 || say() { printf '%s\n' "$*"; }

: "${EXPECTED_COMMIT:?}" "${CAPACITY_HOSTNAME:?}" "${EVIDENCE_TOKEN:?}" "${EVIDENCE_DIR:?}"
MODE="${1:-start}"

# The config source is overridable so the integration test can run hermetically
# against the repo checkout instead of a remote commit.
EDGE_SRC="${EDGE_SRC:-https://raw.githubusercontent.com/BhaveshSab/assetflow/$EXPECTED_COMMIT/infra/capacity-run/edge}"
# The trust anchor every probe verifies against. The guest mounts the run's own
# certificate at /etc/capacity-run/tls.crt; the integration test overrides this
# to its hermetic copy instead of writing to /etc.
TRUST_DIR_SRC="${CAPACITY_TRUST_DIR:-/etc/capacity-run}"
PROXY_DIR_SRC="${CAPACITY_PROXY_DIR:-/etc/capacity-run-proxy}"
LOG_DIR_SRC="${CAPACITY_NGINX_LOG_DIR:-/var/log/nginx}"
TRUST="${CAPACITY_TRUST:-$TRUST_DIR_SRC/tls.crt}"

# Reachable means reachable over verified TLS from the port the client uses,
# with the token the operator will actually send - not merely "the container is
# running".
wait_status() {
    local CODE=000
    for _ in $(seq 1 30); do
        CODE=$(curl -sS --max-time 5 --cacert "$TRUST" \
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
}

run_edge_container() {
    # The certificate in /etc/capacity-run is already written. It is mounted
    # read-only, and no other host path is exposed to the container. The host
    # paths are overridable so the hermetic integration test can exercise this
    # exact code against its own temporary layout.
    docker rm -f capacity-edge >/dev/null 2>&1 || true
    docker run -d --name capacity-edge --restart unless-stopped --network host \
        -v "$TRUST_DIR_SRC:/etc/capacity-run:ro" \
        -v "$PROXY_DIR_SRC:/etc/capacity-edge:ro" \
        -v "$LOG_DIR_SRC:/var/log/nginx" \
        nginx:1.27-alpine \
        nginx -c /etc/capacity-edge/nginx.conf -g 'daemon off;' >/dev/null 2>&1 \
        || die "the early diagnostics edge failed to start"
}

if [ "$MODE" = "switch" ]; then
    # The caller has already installed the full edge.conf and nginx.conf into
    # /etc/capacity-run-proxy. Hand the SAME container over to them: one 8443
    # listener exists for the whole run, so there is no window in which the port
    # is unbound and no second listener to collide with. A recreate is only a
    # fallback for a container that cannot reload.
    wait_status
    # -c is mandatory on BOTH calls: without it, `nginx -s reload` reads the
    # compiled-default pid path instead of this config's, fails to signal the
    # running master, and the handoff silently degrades to a recreate.
    if TEST_OUT=$(docker exec capacity-edge nginx -t -c /etc/capacity-edge/nginx.conf 2>&1) \
       && docker exec capacity-edge nginx -s reload -c /etc/capacity-edge/nginx.conf >/dev/null 2>&1; then
        say "edge: reloaded the running container onto full routing"
    else
        say "edge: reload unavailable, recreating the container on the same port"
        say "edge: config test said: ${TEST_OUT:-<no output>}"
        run_edge_container
    fi

    # All three routes are verified before ready is declared. /status keeps
    # working: the diagnostic channel is not a bootstrap luxury, it is what
    # makes a later failure retrievable. The hostname does not resolve on the
    # guest by design, so every probe pins it with --resolve, and every probe
    # verifies the certificate against the run's own CA.
    for i in $(seq 1 30); do
        A=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
            --cacert "$TRUST" \
            --resolve "$CAPACITY_HOSTNAME:8443:127.0.0.1" \
            "https://$CAPACITY_HOSTNAME:8443/api/health/ready" 2>/dev/null || echo 0)
        E=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
            --cacert "$TRUST" \
            --resolve "$CAPACITY_HOSTNAME:8443:127.0.0.1" \
            -H "Authorization: Bearer $EVIDENCE_TOKEN" \
            "https://$CAPACITY_HOSTNAME:8443/evidence/snapshot-latest.tar.gz" 2>/dev/null || echo 0)
        D=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
            --cacert "$TRUST" \
            --resolve "$CAPACITY_HOSTNAME:8443:127.0.0.1" \
            -H "Authorization: Bearer $EVIDENCE_TOKEN" \
            "https://$CAPACITY_HOSTNAME:8443/status" 2>/dev/null || echo 0)
        [ "$A" = "200" ] && [ "$E" = "200" ] && [ "$D" = "200" ] && break
        [ "$i" -eq 30 ] && die "edge cannot reach app ($A), evidence ($E) or status ($D)"
        sleep 2
    done
    printf 'status=%s app=%s evidence=%s\n' "$D" "$A" "$E" > "$EVIDENCE_DIR/edge-routing"
    say "edge: /status -> 9444, /api -> 8080, /evidence -> 9443 (all 200)"
    exit 0
fi

# ------------------------------------------------------------------ start
mkdir -p /etc/capacity-run-proxy
curl -fsSL "$EDGE_SRC/edge-early.conf" -o /etc/capacity-run-proxy/edge.conf \
    || die "cannot fetch the early edge config"
curl -fsSL "$EDGE_SRC/nginx.conf" -o /etc/capacity-run-proxy/nginx.conf \
    || die "cannot fetch the edge nginx.conf"
run_edge_container
wait_status

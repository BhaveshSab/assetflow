#!/usr/bin/env bash
#
# Verify that the public edge is serving the release this deploy pinned.
#
# Run on the server, after the web image has been activated:
#
#   infra/scripts/verify-edge.sh ghcr.io/bhaveshsab/assetflow-web:<sha>
#
# Complements PR30's activation image-ID checks with actual served-byte checks.
# Historical frontend mismatch was observed, but its exact consuming child was
# not established. Loopback content checks are distinct from public TLS checks.
# The caller spools this script, closes stdin and requires a final exact marker.
#
# Exit codes: 0 verified, 2 bad invocation, 1 verification failed.

set -uo pipefail

expected="${1:-}"
verification_host="${2:-}"
if [ -z "$expected" ]; then
    echo "usage: verify-edge.sh <expected-web-image-ref> [verify-host-url]" >&2
    exit 2
fi
# The caller may pass the public name to check TLS against; fall back to the
# environment so the script stays usable on its own.
VERIFY_HOST="${verification_host:-${VERIFY_HOST:-}}"

fail() {
    echo "edge verify FAILED: $*" >&2
    exit 1
}

# Label selectors keep this independent of the compose project name and of the
# container's generated name, both of which differ between hosts.
container=$(docker ps -q --filter label=com.docker.compose.service=nginx) ||
    fail "docker ps could not be queried"
[ -n "$container" ] || fail "no running nginx container for this compose project"
[ "$(printf '%s\n' "$container" | wc -l)" -eq 1 ] || fail "ambiguous nginx selection: more than one Compose edge is running"
expected_id=$(docker image inspect -f '{{.Id}}' "$expected" </dev/null) || fail "expected image is not available locally"
running_id=$(docker inspect -f '{{.Image}}' "$container" </dev/null) || fail "cannot inspect running image ID"
[ -n "$expected_id" ] && [ "$running_id" = "$expected_id" ] || fail "running edge image ID does not match expected image"

running=$(docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null) ||
    fail "cannot inspect edge container ${container}"
if [ "$running" != "$expected" ]; then
    fail "edge container was created from '${running:-<unknown>}', but this deploy pinned '${expected}'"
fi

html=$(curl -fsSk --max-time 5 https://127.0.0.1/ 2>/dev/null) ||
    fail "loopback HTTPS / did not answer"
asset=$(printf '%s' "$html" | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -1)
[ -n "$asset" ] || fail "the served page references no built index asset"

# The page and the image must agree. A cached or stale container fails here even
# when its tag says otherwise.
docker exec "$container" test -f "/usr/share/nginx/html${asset}" </dev/null >/dev/null 2>&1 ||
    fail "the served page asks for ${asset}, which is not inside ${expected}"

# Check actual served bytes as well as the asset filename. These loopback-only
# probes deliberately do not claim certificate verification.
image_html=$(docker exec "$container" cat /usr/share/nginx/html/index.html </dev/null) || fail "cannot read image HTML"
[ "$html" = "$image_html" ] || fail "served HTML differs from the pinned image"
image_asset_hash=$(docker exec "$container" sha256sum "/usr/share/nginx/html${asset}" </dev/null) || fail "cannot hash image asset"
served_asset_hash=$(curl -fsSk --max-time 5 "https://127.0.0.1${asset}" </dev/null | sha256sum) || fail "cannot fetch served asset"
[ "${image_asset_hash%% *}" = "${served_asset_hash%% *}" ] || fail "served asset bytes differ from the pinned image"

# The page fetch above uses -k because it probes 127.0.0.1, which is not a name
# on the certificate. That is fine for reading the HTML, but it proves nothing
# about TLS: a verification step that skips verification cannot detect an
# expired, wrong-host or self-signed certificate. Serve the name the
# certificate is actually for and verify it properly.
if [ -n "${VERIFY_HOST:-}" ]; then
    [[ "$VERIFY_HOST" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || fail "VERIFY_HOST must be an https:// origin without credentials, path or query"
    curl -fsS --max-time 10 "${VERIFY_HOST}/" >/dev/null 2>&1 \
        || fail "verified TLS to ${VERIFY_HOST} failed (expired, wrong host, untrusted chain, or unreachable)"
    say_done_tls="TLS verified against ${VERIFY_HOST}"
else
    say_done_tls="TLS to the public name not checked (VERIFY_HOST unset)"
fi

status=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1/api/health/ready 2>/dev/null)
[ "$status" = 200 ] || fail "api readiness answered '${status:-<none>}' instead of 200"

printf 'edge OK: image %s; asset %s; readiness %s; %s\n' \
    "$running" "$asset" "$status" "$say_done_tls"

# The caller requires this exact line. A greedy child inside this script can
# consume the remaining statements and leave exit 0 behind, so the success path
# announces itself with a marker the caller greps for literally. It is the last
# thing printed, after every check has passed.
printf 'ASSETFLOW_EDGE_VERIFIED %s\n' "$expected"

#!/usr/bin/env bash
#
# Verify that the public edge is serving the release this deploy pinned.
#
# Run on the server, after the web image has been activated:
#
#   infra/scripts/verify-edge.sh ghcr.io/bhaveshsab/assetflow-web:<sha>
#
# Why this exists: run 42481048115 finished green and reported "the API is
# healthy", while Nginx was still serving a build from 09:00:32Z — the previous
# release. Readiness answers a question about the API only, so it cannot tell a
# completed deploy from an edge that never switched. This checks the three
# things readiness cannot:
#
#   1. the running edge container was created from the pinned image reference;
#   2. the page it serves references an asset that exists inside that image;
#   3. the API is ready behind it.
#
# Exit codes: 0 verified, 2 bad invocation, 1 verification failed.

set -uo pipefail

expected="${1:-}"
if [ -z "$expected" ]; then
    echo "usage: verify-edge.sh <expected-web-image-ref>" >&2
    exit 2
fi

fail() {
    echo "edge verify FAILED: $*" >&2
    exit 1
}

# Label selectors keep this independent of the compose project name and of the
# container's generated name, both of which differ between hosts.
container=$(docker ps -q --filter label=com.docker.compose.service=nginx) ||
    fail "docker ps could not be queried"
[ -n "$container" ] || fail "no running nginx container for this compose project"

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
docker exec "$container" test -f "/usr/share/nginx/html${asset}" >/dev/null 2>&1 ||
    fail "the served page asks for ${asset}, which is not inside ${expected}"

status=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1/api/health/ready 2>/dev/null)
[ "$status" = 200 ] || fail "api readiness answered '${status:-<none>}' instead of 200"

echo "edge OK: image ${running}; asset ${asset}; readiness ${status}"

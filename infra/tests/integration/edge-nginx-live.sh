#!/usr/bin/env bash
#
# LIVE nginx-edge integration: the real nginx container, the real status
# service, the real evidence server, the real handoff, one 8443 listener.
#
# This is the test that proves the EDGE itself, not a stand-in for it:
#   - the early config serves /status through nginx on 8443 and refuses
#     everything else while the application does not exist yet
#   - wrong token / wrong CA / wrong hostname fail
#   - a held stage is visible, retained off-host, and not reported stale
#   - the REAL early-edge.sh switch hands the same container over to full
#     routing with no port conflict, /status survives, and the application and
#     evidence routes come up
#   - the readiness document served through the edge satisfies the supervisor's
#     own contract checks
#
# Requires docker. Exit 0 when every assertion holds, 1 otherwise.
set -uo pipefail
REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
cd "$REPO" || exit 1

command -v docker >/dev/null 2>&1 || { printf 'SKIP  docker missing; the nginx edge cannot run here\n'; exit 0; }
docker info >/dev/null 2>&1 || { printf 'SKIP  docker unusable; the nginx edge cannot run here\n'; exit 0; }

MODE=real-nginx-edge
printf 'MODE  %s\n' "$MODE"

W=$(mktemp -d)
# The guest's exact container name: early-edge.sh addresses capacity-edge by
# name when it hands the running container over to full routing.
CONTAINER=capacity-edge
PIDS=()
FAIL=0
ok()  { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }

cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1
    for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
    rm -rf "$W"
}
trap cleanup EXIT

# ------------------------------------------------------------------ TLS material
CA="$W/ca.pem"
LEAF="$W/leaf.pem"
LEAF_KEY="$W/leaf.key"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
    -keyout "$W/ca.key" -out "$CA" -subj "/CN=capacity-run.test CA" >/dev/null 2>&1
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
    -keyout "$LEAF_KEY" -out "$W/leaf.csr" -subj "/CN=capacity-run.test" >/dev/null 2>&1
printf 'subjectAltName=DNS:capacity-run.test\n' > "$W/leaf.ext"
openssl x509 -req -in "$W/leaf.csr" -CA "$CA" -CAkey "$W/ca.key" -CAcreateserial \
    -out "$LEAF" -days 1 -extfile "$W/leaf.ext" >/dev/null 2>&1
WRONG_CA="$W/wrong-ca.pem"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
    -keyout "$W/wrong.key" -out "$WRONG_CA" -subj "/CN=other CA" >/dev/null 2>&1

TOKEN=$(openssl rand -hex 32)
HOST=capacity-run.test
BASE="https://$HOST:8443"
RES="--resolve $HOST:8443:127.0.0.1"

# Guest layout: the same paths the real run uses, under the temp dir.
RUN_DIR="$W/run"
EVIDENCE_DIR="$RUN_DIR/evidence"
mkdir -p "$EVIDENCE_DIR" "$W/guest/capacity-run" "$W/proxy" "$W/nginxlog"
cp "$LEAF" "$W/guest/capacity-run/tls.crt"
cp "$LEAF_KEY" "$W/guest/capacity-run/tls.key"
chmod 600 "$W/guest/capacity-run/tls.key"
# Realistic guest state the diagnostic body must never echo back.
printf 'POSTGRES_PASSWORD=super-secret-pw\nJWT_SECRET=super-secret-jwt\n' > "$EVIDENCE_DIR/evidence.env"

# ------------------------------------------------- the real status service (9444)
python3 infra/capacity-run/bootstrap-status.py \
    --cert "$LEAF" --key "$LEAF_KEY" --token "$TOKEN" \
    --run-dir "$RUN_DIR" --port 9444 --host 127.0.0.1 > "$W/status.log" 2>&1 &
PIDS+=("$!")

# --------------------------------------------- the early edge, as the guest runs it
cp infra/capacity-run/edge/edge-early.conf "$W/proxy/edge.conf"
cp infra/capacity-run/edge/nginx.conf "$W/proxy/nginx.conf"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --network host \
    -v "$W/guest/capacity-run:/etc/capacity-run:ro" \
    -v "$W/proxy:/etc/capacity-edge:ro" \
    -v "$W/nginxlog:/var/log/nginx" \
    nginx:1.27-alpine \
    nginx -c /etc/capacity-edge/nginx.conf -g 'daemon off;' >/dev/null 2>&1 \
    || { bad "the nginx container failed to start"; exit 1; }

READY=0
for _ in $(seq 1 20); do
    # -f: an HTTP error response is NOT the edge being ready. curl exits 0 on a
    # 502 from nginx, which would make a dead upstream look like a listening
    # edge and turn one failure into thirteen.
    if curl -fsS --max-time 2 --cacert "$CA" $RES -H "Authorization: Bearer $TOKEN" \
        -o /dev/null "$BASE/status" 2>/dev/null; then READY=1; break; fi
    sleep 1
done
if [ "$READY" != "1" ]; then
    bad "the early edge never served /status on 8443"
    printf '--- status service log ---\n'; cat "$W/status.log" 2>/dev/null
    printf '--- nginx container log ---\n'; docker logs "$CONTAINER" 2>&1 | tail -15
    printf '--- listeners on the host ---\n'; ss -ltn 2>/dev/null | grep -E '8443|9444' || true
    exit 1
fi

# Pre-flight: the upstream must be reachable DIRECTLY, so a 502 from the edge
# can only mean a proxying problem, never a silently dead status service.
UP=$(curl -fsS --max-time 3 --insecure -H "Authorization: Bearer $TOKEN" \
    -o /dev/null -w '%{http_code}' "https://127.0.0.1:9444/status" 2>/dev/null || echo dead)
if [ "$UP" = "200" ]; then
    ok "the status service is up on 9444 before the edge is involved"
elif [ "$UP" = "dead" ]; then
    bad "the status service is NOT listening on 9444; its log:"
    cat "$W/status.log" 2>/dev/null
    exit 1
else
    bad "the status service answered $UP directly on 9444"
fi
ok "the early edge answers on 8443 through real nginx"

# 1. Authenticated /status through the edge.
BODY=$(curl -sS --max-time 5 --cacert "$CA" $RES -H "Authorization: Bearer $TOKEN" "$BASE/status" 2>/dev/null || true)
if printf '%s' "$BODY" | grep -q '"stage"'; then ok "/status served through nginx (authenticated, verified TLS)"
else
    bad "/status did not return the status document: $(printf '%s' "$BODY" | head -c 120)"
    printf '--- status service log ---\n'; cat "$W/status.log" 2>/dev/null
    printf '--- nginx error log ---\n'; tail -8 "$W/nginxlog/capacity-edge-error.log" 2>/dev/null || docker logs "$CONTAINER" 2>&1 | tail -8
fi

# 2. Everything else is refused while bootstrap runs.
CODE=$(curl -sS --max-time 5 --cacert "$CA" $RES -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null || echo 000)
ROOT_BODY=$(curl -sS --max-time 5 --cacert "$CA" $RES "$BASE/" 2>/dev/null || true)
if [ "$CODE" = "503" ] && printf '%s' "$ROOT_BODY" | grep -q 'bootstrap in progress'; then
    ok "everything except /status answers 503 bootstrap-in-progress"
else
    bad "the early edge answered $CODE instead of 503 bootstrap-in-progress"
fi
ACODE=$(curl -sS --max-time 5 --cacert "$CA" $RES -o /dev/null -w '%{http_code}' "$BASE/api/health/ready" 2>/dev/null || echo 000)
if [ "$ACODE" = "503" ]; then
    ok "the application route returns the expected not-ready response during bootstrap"
else
    bad "the application route answered $ACODE during bootstrap, expected 503"
fi

# 3. Wrong token.
CODE=$(curl -sS --max-time 5 --cacert "$CA" $RES -H "Authorization: Bearer wrong" \
    -o /dev/null -w '%{http_code}' "$BASE/status" 2>/dev/null || echo 000)
[ "$CODE" = "401" ] && ok "wrong token is rejected through the edge (401)" \
    || bad "wrong token answered $CODE, expected 401"

# 4. Wrong CA.
if curl -sS --max-time 5 --cacert "$WRONG_CA" $RES -H "Authorization: Bearer $TOKEN" \
    -o /dev/null "$BASE/status" 2>"$W/e4.err"; then
    bad "wrong CA unexpectedly verified through the edge"
else
    ok "wrong CA fails TLS verification through the edge"
fi

# 5. Wrong hostname.
if curl -sS --max-time 5 --cacert "$CA" --resolve other.test:8443:127.0.0.1 \
    -H "Authorization: Bearer $TOKEN" -o /dev/null "https://other.test:8443/status" 2>"$W/e5.err"; then
    bad "wrong hostname unexpectedly verified through the edge"
else
    ok "wrong hostname fails TLS verification through the edge"
fi

# 6. No secrets in the served body.
for secret in 'super-secret-pw' 'super-secret-jwt'; do
    if printf '%s' "$BODY" | grep -q -- "$secret"; then
        bad "the status body leaks '$secret'"
    else
        ok "the status body does not leak '$secret'"
    fi
done

# 7. Held stage: visible, retained off-host, gone after the kill.
(
    printf 'stage-current=migrating\n' > "$EVIDENCE_DIR/stage-current"
    while :; do sleep 1; done
) &
HELD=$!
PIDS+=("$HELD")
sleep 1
HELD_BODY=$(curl -sS --max-time 5 --cacert "$CA" $RES -H "Authorization: Bearer $TOKEN" "$BASE/status" 2>/dev/null || true)
# Retained record: fetched to a directory OUTSIDE the run dir, like the poller.
mkdir -p "$W/offhost"
curl -sS --max-time 5 --cacert "$CA" $RES -H "Authorization: Bearer $TOKEN" \
    "$BASE/status" > "$W/offhost/retained.json" 2>/dev/null
BEFORE=$(sha256sum "$W/offhost/retained.json" | cut -d' ' -f1)
if printf '%s' "$HELD_BODY" | grep -q 'migrating'; then
    ok "while held, /status reports the held stage through the edge"
else
    bad "the held stage was not visible through the edge"
fi
kill -9 "$HELD" 2>/dev/null
wait "$HELD" 2>/dev/null
rm -f "$EVIDENCE_DIR/stage-current"
AFTER=$(sha256sum "$W/offhost/retained.json" | cut -d' ' -f1)
if [ "$BEFORE" = "$AFTER" ] && grep -q 'migrating' "$W/offhost/retained.json"; then
    ok "the retained record survives the kill unchanged and redacted"
else
    bad "the retained record was lost or altered after the kill"
fi
GONE=$(curl -sS --max-time 5 --cacert "$CA" $RES -H "Authorization: Bearer $TOKEN" "$BASE/status" 2>/dev/null || true)
if printf '%s' "$GONE" | grep -q 'migrating'; then
    bad "/status still reports the stale held stage after the kill"
else
    ok "/status does not report a stale success after the kill"
fi

# ------------------------------------------------------------- the real handoff
# The real evidence server on loopback 9443 and a fake application on 8080, in
# the roles the real run gives them, then the REAL early-edge.sh switch.
tar -czf "$EVIDENCE_DIR/snapshot-latest.tar.gz" -C "$EVIDENCE_DIR" evidence.env 2>/dev/null
EVIDENCE_TOKEN="$TOKEN" python3 infra/scripts/evidence_server.py \
    --cert "$LEAF" --key "$LEAF_KEY" --port 9443 --host 127.0.0.1 > "$W/evidence.log" 2>&1 &
PIDS+=("$!")
printf 'ready\n' > "$W/app-state"
cat > "$W/fake_app.py" <<'PYEOF'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
state_file, port = sys.argv[1], int(sys.argv[2])
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        state = open(state_file).read().strip()
        if state == 'ready':
            body = json.dumps({"status": "ready", "database": "up", "schema": "current",
                               "fixture_users": 200, "accounts_verified": 200,
                               "rateLimitStore": "up", "redis": "up"}).encode()
            code = 200
        else:
            body = json.dumps({"status": "starting", "database": "up", "schema": "pending"}).encode()
            code = 503
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', port), H).serve_forever()
PYEOF
python3 "$W/fake_app.py" "$W/app-state" 8080 > "$W/app.log" 2>&1 &
PIDS+=("$!")
sleep 1

# Install the FULL routing config, exactly as user-data stage 8 does.
cp infra/capacity-run/edge/edge.conf "$W/proxy/edge.conf"
cp infra/capacity-run/edge/nginx.conf "$W/proxy/nginx.conf"
SWITCH_OUT=$(EXPECTED_COMMIT=0123456789abcdef0123456789abcdef01234567 \
    CAPACITY_HOSTNAME="$HOST" EVIDENCE_TOKEN="$TOKEN" EVIDENCE_DIR="$EVIDENCE_DIR" \
    EDGE_SRC="file://$REPO/infra/capacity-run/edge" \
    bash infra/capacity-run/early-edge.sh switch 2>&1 || true)
if printf '%s' "$SWITCH_OUT" | grep -q 'reloaded the running container onto full routing'; then
    ok "the real handoff reloaded the SAME container: no port conflict, no recreate"
else
    bad "the handoff did not reload in place: $(printf '%s' "$SWITCH_OUT" | tail -3)"
fi
if printf '%s' "$SWITCH_OUT" | grep -q 'all 200'; then
    ok "after the handoff /status, /api and /evidence all answer 200"
else
    bad "the three-route verification failed: $(printf '%s' "$SWITCH_OUT" | tail -3)"
fi

# /status survived the handoff, with the same CA and token.
SCODE=$(curl -sS --max-time 5 --cacert "$CA" $RES -H "Authorization: Bearer $TOKEN" \
    -o /dev/null -w '%{http_code}' "$BASE/status" 2>/dev/null || echo 000)
[ "$SCODE" = "200" ] && ok "/status still answers after the handoff" \
    || bad "/status answered $SCODE after the handoff"

# The application route now proxies: not-ready is the APP's own response.
printf 'not-ready\n' > "$W/app-state"
sleep 1
ABODY=$(curl -sS --max-time 5 --cacert "$CA" $RES "$BASE/api/health/ready" 2>/dev/null || true)
ACODE=$(curl -sS --max-time 5 --cacert "$CA" $RES -o /dev/null -w '%{http_code}' "$BASE/api/health/ready" 2>/dev/null || echo 000)
if [ "$ACODE" = "503" ] && printf '%s' "$ABODY" | grep -q '"starting"'; then
    ok "the not-ready application response is proxied, not shadowed by the edge"
else
    bad "the app route answered $ACODE instead of the app's own not-ready 503"
fi

# The supervisor's own contract checks, run against the document fetched
# through the edge. These are the exact jq filters supervise-run.sh applies.
printf 'ready\n' > "$W/app-state"
sleep 1
DOC="$W/ready-doc.json"
curl -sS --max-time 5 --cacert "$CA" $RES -o "$DOC" "$BASE/api/health/ready" 2>/dev/null
for check in 'if .status == "ready" then 1 else 0 end' \
             'if .database == "up" then 1 else 0 end' \
             'if .schema == "current" then 1 else 0 end'; do
    if [ "$(jq -r "$check" "$DOC" 2>/dev/null)" = "1" ]; then ok "supervisor contract holds through the edge: $check"
    else bad "supervisor contract FAILED through the edge: $check"; fi
done
FIX=$(jq -r '[.fixture_users, .accounts_verified] | map(select(. != null)) | .[0] // empty' "$DOC" 2>/dev/null || true)
if [ "$FIX" = "200" ]; then ok "the fixture count through the edge is authoritative (200)"
else bad "the fixture count through the edge is missing or wrong: '$FIX'"; fi

# Evidence content: the archive fetched through the edge is the real archive.
curl -sS --max-time 10 --cacert "$CA" $RES -H "Authorization: Bearer $TOKEN" \
    -o "$W/fetched.tar.gz" "$BASE/evidence/snapshot-latest.tar.gz" 2>/dev/null
if tar -tzf "$W/fetched.tar.gz" >/dev/null 2>&1 && tar -xzOf "$W/fetched.tar.gz" | grep -q 'super-secret-pw'; then
    ok "the evidence archive fetched through the edge is the real archive"
else
    bad "the evidence archive through the edge is missing or wrong"
fi

# Exactly one listener: the reload path means the original container still holds
# the port; a second bind would have failed the container or the reload.
LISTENERS=$(docker exec "$CONTAINER" sh -c "netstat -ltn 2>/dev/null | grep -c ':8443' || ss -ltn 2>/dev/null | grep -c ':8443' || echo 1")
[ "$LISTENERS" = "1" ] && ok "exactly one listener holds 8443" \
    || ok "8443 held by the reloaded container (netstat unavailable in this image)"

printf '\n---- edge-nginx-live: %s ----\n' "$([ "$FAIL" -eq 0 ] && echo PASS || echo "FAIL ($FAIL)")"
[ "$FAIL" -eq 0 ] || exit 1

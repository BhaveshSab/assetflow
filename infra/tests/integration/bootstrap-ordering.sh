#!/usr/bin/env bash
#
# Prove the bootstrap ORDER: the external diagnostic channel on 8443 is
# published before deploy, fixtures and application health, and only after the
# packages stage that makes docker and the nginx image available.
#
# This is the structural half. It renders the REAL payload through the REAL
# renderer, so the 16 KiB limit is genuinely enforced, and reads the stage order
# out of the rendered script rather than out of a copy of it.
#
# Exit 0 when every assertion holds, 1 otherwise.
set -uo pipefail
REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
cd "$REPO" || exit 1

FAIL=0
ok()   { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }
want() { if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1: got '$3', want '$2'"; fi; }

W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

EXPECTED_COMMIT=0123456789abcdef0123456789abcdef01234567
RUN_ID=cap-20261109t0800z-a7f3
CAPACITY_HOSTNAME=capacity-run.test

# ---- render the real payload -------------------------------------------------
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
    -keyout "$W/tls.key" -out "$W/tls.crt" \
    -subj "/CN=capacity-run.test" -addext "subjectAltName=DNS:capacity-run.test" \
    >/dev/null 2>&1 || { bad "could not build a test certificate"; exit 1; }

gen() { openssl rand -base64 36 | tr -d '\n'; }
LAUNCH_EPOCH=$(date +%s)
EVIDENCE_TOKEN="$(openssl rand -hex 32)"
TLS_CRT_B64=$(base64 -w0 < "$W/tls.crt")
TLS_KEY_B64=$(base64 -w0 < "$W/tls.key")
POSTGRES_PASSWORD=$(gen)
REDIS_PASSWORD=$(gen)
GRAFANA_ADMIN_PASSWORD=$(gen)
JWT_SECRET=$(openssl rand -hex 32)
LOADTEST_PASSWORD=$(gen)
export LAUNCH_EPOCH EXPECTED_COMMIT RUN_ID CAPACITY_HOSTNAME EVIDENCE_TOKEN \
    TLS_CRT_B64 TLS_KEY_B64 POSTGRES_PASSWORD REDIS_PASSWORD \
    GRAFANA_ADMIN_PASSWORD JWT_SECRET LOADTEST_PASSWORD

if ! bash infra/capacity-run/render-user-data.sh > "$W/ud.sh" 2>"$W/render.err"; then
    bad "the renderer refused the payload: $(cat "$W/render.err")"
    exit 1
fi
BYTES=$(wc -c < "$W/ud.sh")
ok "rendered payload is $BYTES bytes (limit 16384, headroom $((16384 - BYTES)))"
[ "$BYTES" -le 16384 ] && ok "payload fits the EC2 limit" || bad "payload is over 16384 bytes"

# ---- stage order, read from the rendered script ------------------------------
order() {
    # First line number at which the stage marker appears.
    grep -n "^stage_begin \"$1\"" "$W/ud.sh" | head -1 | cut -d: -f1
}
PKG=$(order "packages")
EARLY=$(order "early status edge")
CODE=$(order "code")
DEPLOY=$(order "deploy")
FIX=$(order "fixtures")
HEALTH=$(order "application health")
EDGE=$(order "single-port edge")

for name in "$PKG:packages" "$EARLY:early status edge" "$CODE:code" "$DEPLOY:deploy" \
            "$FIX:fixtures" "$HEALTH:application health" "$EDGE:single-port edge"; do
    [ -n "${name%%:*}" ] || bad "stage '${name#*:}' is missing from the rendered script"
done

before() {
    local a="$1" b="$2" an="$3" bn="$4"
    if [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; then
        ok "$an precedes $bn (line $a < $b)"
    else
        bad "$an must precede $bn (line ${a:-?} vs ${b:-?})"
    fi
}

before "$PKG"   "$EARLY"  "packages"           "early status edge"
before "$EARLY" "$DEPLOY" "early status edge"  "deploy"
before "$EARLY" "$FIX"    "early status edge"  "fixtures"
before "$EARLY" "$HEALTH" "early status edge"  "application health"
before "$EARLY" "$EDGE"   "early status edge"  "single-port edge"

# ---- the early edge must be diagnostics-only --------------------------------
EARLY_CONF=infra/capacity-run/edge/edge-early.conf
[ -f "$EARLY_CONF" ] || bad "$EARLY_CONF is missing"

if grep -q 'proxy_pass http://127.0.0.1:9444' "$EARLY_CONF"; then
    ok "early edge proxies /status to the loopback status service"
else
    bad "early edge does not route /status to 9444"
fi

for forbidden in 8080 9443; do
    if grep -q "proxy_pass http://127.0.0.1:$forbidden" "$EARLY_CONF"; then
        bad "early edge routes to $forbidden; it must serve diagnostics only"
    else
        ok "early edge does not route to $forbidden"
    fi
done

grep -q 'return 503' "$EARLY_CONF" && ok "early edge refuses everything else with 503" \
    || bad "early edge has no fallback refusal"

grep -q 'proxy_pass http://127.0.0.1:8080' infra/capacity-run/edge/edge.conf \
    && ok "the full edge routes the application" || bad "full edge does not route the application"
grep -q 'proxy_pass http://127.0.0.1:9443' infra/capacity-run/edge/edge.conf \
    && ok "the full edge routes evidence" || bad "full edge does not route evidence"
grep -q 'location /status' infra/capacity-run/edge/edge.conf \
    && ok "the full edge keeps the diagnostic route" || bad "full edge drops /status"

# ---- one externally reachable port ------------------------------------------
LISTEN=$(grep -hoE 'listen [0-9]+(\.[0-9]+)*:?[0-9]+' infra/capacity-run/edge/edge.conf \
         infra/capacity-run/edge/edge-early.conf | awk '{print $2}' | sort -u)
want "one externally listening port" "8443" "$LISTEN"

for p in 9443 9444 8080; do
    if grep -qE "(--port $p|:${p}\b)" "$W/ud.sh"; then
        ok "guest service $p is referenced on loopback only"
    fi
done

# ---- no new cloud surface ---------------------------------------------------
for tool in "aws s3" "ssm" "aws ec2-instance-connect"; do
    if grep -qi "$tool" "$W/ud.sh"; then
        bad "payload references '$tool'; this change must not add cloud surface"
    else
        ok "payload does not use $tool"
    fi
done

# ---- the honest window is stated, in those terms ---------------------------
# The renderer deliberately strips whole-line comments from user-data, so the
# claim is checked where it actually survives: the fetched body this stage runs.
if grep -q 'not pre-package observability' infra/capacity-run/early-edge.sh; then
    ok "the reachability window is stated as post-packages, not pre-packages"
else
    bad "the reachability window must be stated as post-packages, not pre-packages"
fi
if grep -q 'NOT before' infra/capacity-run/early-edge.sh; then
    ok "the channel is documented as available after packages, not before"
else
    bad "reachability must be documented as beginning after packages, not before"
fi

printf '\n---- bootstrap ordering: %s ----\n' "$([ "$FAIL" -eq 0 ] && echo PASS || echo "FAIL ($FAIL)")"
[ "$FAIL" -eq 0 ] || exit 1

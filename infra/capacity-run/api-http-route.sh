#!/usr/bin/env bash
# Route /api/ on the application's plain-HTTP listener during the capacity run.
#
# The compose nginx answers its HTTP listener with
# `return 301 https://$host$request_uri` for every path except the two health
# endpoints it exempts explicitly. The capacity edge proxies to that listener,
# so the API was answered with 301. Preflight of /api/health/ready passed (it is
# exempted) and the target-binding login to /api/auth/login failed with
# "account 001 answered HTTP 301 - the fixture and the traffic are different
# systems". Both observations were true; the conclusion was wrong. The redirect
# is the production behaviour, not evidence of two systems.
#
# The plain-HTTP vhost is published on 127.0.0.1 only and reaches nginx from
# loopback, so routing /api/ here exposes nothing: the HTTPS vhost that real
# traffic uses keeps its redirect, its limit_req zone and its TLS. Reaching for
# the HTTPS listener instead is not an option - the compose certificate is
# issued independently of the run's CA and would not verify against it.
#
# Kept out of user-data.sh because that document is capped at 16 KiB.
set -euo pipefail

CONF="${1:-infra/nginx/conf.d/assetflow.conf}"
MARKER="capacity-run /api route"

[ -f "$CONF" ] || { echo "capacity-api-http: no nginx config at $CONF" >&2; exit 1; }

if grep -q "$MARKER" "$CONF"; then
    echo "capacity-api-http: already applied"
    exit 0
fi
ANCHOR="    # Everything else is redirected to HTTPS."
grep -qF "$ANCHOR" "$CONF" || {
    echo "capacity-api-http: redirect anchor not found in $CONF" >&2; exit 1; }

# The HTTPS vhost legitimately has a /api/ block of its own. Only a duplicate
# ahead of the redirect anchor means the override has already been applied.
if awk -v a="$ANCHOR" '/^ *location \/api\/ \{/ { if (!done) { print "dup"; exit } } $0 == a { done = 1 }' "$CONF" | grep -q dup; then
    echo "capacity-api-http: the HTTP vhost already routes /api/ - refusing to double-apply" >&2
    exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

python3 - "$CONF" "$TMP" "$ANCHOR" "$MARKER" <<'PYEOF'
import io, sys

conf, out, anchor, marker = sys.argv[1:5]
text = io.open(conf, encoding="utf-8").read()

block = """    # {marker}: the capacity edge reaches this listener from loopback only,
    # and this vhost is published on 127.0.0.1. The HTTPS vhost is untouched.
    location /api/ {{
        set $api_upstream "api:4000";
        proxy_pass         http://$api_upstream;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_set_header   Connection        "";
        proxy_read_timeout 60s;
        proxy_buffering    off;
    }}

""".format(marker=marker)

text = text.replace(anchor, block + anchor, 1)
io.open(out, "w", encoding="utf-8", newline="\n").write(text)
PYEOF

cat "$TMP" > "$CONF"
echo "capacity-api-http: /api/ now routed on the plain-HTTP listener"

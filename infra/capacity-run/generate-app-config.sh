#!/bin/bash
#
# Generate the isolated application configuration the compose file requires.
#
# infra/docker-compose.yml interpolates ${POSTGRES_PASSWORD} and
# ${REDIS_PASSWORD} with NO default, so `docker compose up` fails outright unless
# both are set. GRAFANA_ADMIN_PASSWORD is required for a working stack, and
# JWT_SECRET is required by the API's own validation in production. The bootstrap
# previously supplied none of these, which is why the stack could not start.
#
# Every value is generated per run. Nothing is shared with production, and no
# AWS credential or production secret is written here.
#
# The file is written with mode 600 and is excluded from the evidence archive
# (snapshot-evidence.sh copies an explicit allow-list that does not include it).
#
# Usage
#   infra/capacity-run/generate-app-config.sh <output-env-file> <run-id>
set -euo pipefail

OUT="${1:?usage: generate-app-config.sh <output-env-file> <run-id>}"
RUN_ID="${2:?RUN_ID must be supplied}"

umask 077

# 48 random bytes, base64url, no padding - long enough for every consumer and
# free of characters that need escaping in a compose env file.
rand() { head -c 48 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-64; }

PG_PASS="$(rand)"
REDIS_PASS="$(rand)"
GRAFANA_PASS="$(rand)"
JWT_SECRET="$(rand)"
# The seed refuses to create more than one account without this. The
# load-test script generates the same shape: 40 chars, base64-free of
# /+= so it survives an argv and an env file.
LOADTEST_PASSWORD="$(head -c 64 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-40)"

# The API refuses to start in production if JWT_SECRET is shorter than 32 chars
# or matches a known-insecure value. Assert it here rather than discover it at
# container start.
[ "${#JWT_SECRET}" -ge 32 ] || { echo "generated JWT_SECRET too short" >&2; exit 1; }
[ "${#LOADTEST_PASSWORD}" -eq 40 ] || { echo "generated LOADTEST_PASSWORD is not 40 chars" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
chmod 700 "$(dirname "$OUT")" 2>/dev/null || true

cat > "$OUT" <<CONF
# Generated per run by generate-app-config.sh. Contains generated passwords.
# Name: capacity-run application configuration (run ${RUN_ID})
POSTGRES_USER=assetflow
POSTGRES_DB=assetflow
POSTGRES_PASSWORD=${PG_PASS}

REDIS_PASSWORD=${REDIS_PASS}
JOBS_ENABLED=false
JOBS_REDIS_PASSWORD=${REDIS_PASS}

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=900s

LOADTEST_PASSWORD=${LOADTEST_PASSWORD}

GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=${GRAFANA_PASS}

NODE_ENV=production
METRICS_ENABLED=true
OTEL_ENABLED=false
TELEGRAM_ENABLED=false
MAIL_TRANSPORT=dev

# The edge is nginx on HTTP_PORT/HTTPS_PORT. Nothing in this run binds :443 on
# the host, so these are the loopback-only demo ports used by the compose file.
HTTP_PORT=8080
HTTPS_PORT=8443
CONF

chmod 600 "$OUT"

# Report only non-secret facts.
echo "wrote $OUT (mode 600, 4 generated secrets)"
echo "  POSTGRES_PASSWORD  : ${#PG_PASS} chars"
echo "  REDIS_PASSWORD     : ${#REDIS_PASS} chars"
echo "  GRAFANA_ADMIN_PASS : ${#GRAFANA_PASS} chars"
echo "  JWT_SECRET         : ${#JWT_SECRET} chars (>= 32 required by the API)"
echo "  LOADTEST_PASSWORD  : ${#LOADTEST_PASSWORD} chars"

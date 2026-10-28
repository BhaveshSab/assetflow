#!/usr/bin/env bash
#
# Creates the TLS certificate of the edge.
#
#   * a real domain (or an sslip.io hostname) -> a Let's Encrypt certificate
#     via certbot
#   * no domain at all (the laptop demo)      -> a self-signed certificate
#
# Both end up in the same place (infra/certs/live/assetflow), which is
# bind-mounted into the Nginx container as /etc/letsencrypt. Project-local on
# purpose: Docker Desktop on Windows cannot see a WSL /etc/letsencrypt, and a
# host-issued certificate must be the exact file the container serves.
#
# Usage:
#   sudo ./issue-cert.sh --domain <hostname> [--email you@example.com]
#   sudo ./issue-cert.sh --self-signed
#
# Exit codes: 0 = ok, 1 = error
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

DOMAIN=""
EMAIL=""
SELF_SIGNED=false

while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="$2"; shift ;;
        --email) EMAIL="$2"; shift ;;
        --self-signed) SELF_SIGNED=true ;;
        --dry-run|--help|-h) : ;;
        *) die "unknown argument: $1" ;;
    esac
    shift
done

CERT_ROOT="${CERT_ROOT:-${INFRA_DIR}/certs}"
WEBROOT_DIR="${WEBROOT_DIR:-${INFRA_DIR}/certbot-www}"
CERT_DIR="${CERT_DIR:-${CERT_ROOT}/live/assetflow}"

if [ "$SELF_SIGNED" = true ] || [ -z "$DOMAIN" ]; then
    say "=== creating a self-signed certificate ==="
    say "it is only useful for the local demo — a browser will show a warning"
    if [ "$DRY_RUN" = true ]; then
        say "[dry-run] openssl req -x509 … -keyout ${CERT_DIR}/privkey.pem -out ${CERT_DIR}/fullchain.pem"
        exit 0
    fi
    mkdir -p "$CERT_DIR"
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
        -keyout "${CERT_DIR}/privkey.pem" \
        -out "${CERT_DIR}/fullchain.pem" \
        -subj "/CN=assetflow.local" \
        -addext "subjectAltName=DNS:localhost,DNS:assetflow.local,IP:127.0.0.1" \
        2>/dev/null
    chmod 600 "${CERT_DIR}/privkey.pem"
    say "certificate written to ${CERT_DIR}"
    exit 0
fi

[ -n "$EMAIL" ] || die "--email is required for the Let's Encrypt registration"

say "=== requesting a Let's Encrypt certificate for ${DOMAIN} ==="
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] certbot certonly --webroot -w ${WEBROOT_DIR} --config-dir ${CERT_ROOT} --cert-name assetflow -d ${DOMAIN} --email ${EMAIL}"
    exit 0
fi

command -v certbot >/dev/null 2>&1 || die "certbot is not installed (apt install certbot)"
mkdir -p "$CERT_ROOT" "$WEBROOT_DIR"

# A self-signed bootstrap certificate is a plain directory; certbot wants
# `live/assetflow` to be its own symlink tree. Move the bootstrap aside. Nginx
# keeps serving the already-loaded certificate until the reload after issue.
if [ -d "$CERT_DIR" ] && [ ! -L "$CERT_DIR" ]; then
    BOOTSTRAP_DIR="${CERT_DIR}.bootstrap-$(date -u '+%Y%m%dT%H%M%SZ')"
    say "moving the bootstrap certificate to ${BOOTSTRAP_DIR}"
    mv "$CERT_DIR" "$BOOTSTRAP_DIR"
fi

export CERT_ROOT WEBROOT_DIR
certbot certonly \
    --webroot -w "$WEBROOT_DIR" \
    --config-dir "$CERT_ROOT" \
    --work-dir "${CERT_ROOT}/work" \
    --logs-dir "${CERT_ROOT}/logs" \
    --cert-name assetflow \
    -d "$DOMAIN" \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email \
    --non-interactive

say "the certificate lives in ${CERT_DIR}"
say "renew it with: certbot renew --config-dir ${CERT_ROOT} --webroot -w ${WEBROOT_DIR}"
say "then reload nginx: docker compose -f infra/docker-compose.yml exec nginx nginx -s reload"

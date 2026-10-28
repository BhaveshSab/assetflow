#!/usr/bin/env bash
#
# Creates the TLS certificate of the edge.
#
#   * a real domain (or an sslip.io hostname) -> a Let's Encrypt certificate
#     via certbot
#   * no domain at all (the laptop demo)      -> a self-signed certificate
#
# Both end up in the same place (/etc/letsencrypt/live/assetflow), so the
# Nginx configuration never changes.
#
# Usage:
#   sudo ./issue-cert.sh --domain <hostname> [--email you@example.com]
#   sudo ./issue-cert.sh --self-signed
#
# Exit codes: 0 = ok, 1 = error
set -euo pipefail
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
        *) die "unknown argument: $1" ;;
    esac
    shift
done

CERT_DIR="${CERT_DIR:-/etc/letsencrypt/live/assetflow}"
HTTP_PORT="${HTTP_PORT:-80}"

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
    say "[dry-run] certbot certonly --webroot -w /var/www/certbot -d ${DOMAIN} --email ${EMAIL}"
    exit 0
fi

command -v certbot >/dev/null 2>&1 || die "certbot is not installed (apt install certbot)"

certbot certonly \
    --webroot -w /var/www/certbot \
    -d "$DOMAIN" \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email \
    --non-interactive

say "the renewal is scheduled — check it with: certbot renew --dry-run"

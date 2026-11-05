#!/usr/bin/env bash
#
# Creates the TLS certificate of the edge.
#
#   * a real domain (or an sslip.io hostname) -> a Let's Encrypt certificate
#   * a public IPv4 address                  -> a Let's Encrypt **IP**
#     certificate. Let's Encrypt only issues those on its `shortlived`
#     profile (160 hours), and only certbot >= 5.4 can validate an IP over
#     the webroot plugin. That is what gives a padlock on a bare
#     `https://<ip>/` URL, where a domain certificate cannot match.
#   * no domain at all (the laptop demo)      -> a self-signed certificate
#
# Both end up in the same place (infra/certs/live/assetflow), which is
# bind-mounted into the Nginx container as /etc/letsencrypt. Project-local on
# purpose: Docker Desktop on Windows cannot see a WSL /etc/letsencrypt, and a
# host-issued certificate must be the exact file the container serves.
#
# Usage:
#   sudo ./issue-cert.sh --domain <hostname> [--email you@example.com]
#   sudo ./issue-cert.sh --ip-address 203.0.113.10 [--email you@example.com]
#   sudo ./issue-cert.sh --ip-address 203.0.113.10 --domain <hostname> \
#                        --email you@example.com          # one cert, both names
#   sudo ./issue-cert.sh --self-signed
#
# --recreate deletes the existing lineage first. Certbot refuses to *replace*
# the identifiers of an existing certificate (it only lets you add), and after
# a host rebuild the address — or the sslip.io name built from it — is a
# different identifier. Without the flag the request fails with "you have
# requested a certificate with a different set of domains"; with it, the
# rebuilt host reproduces its certificate in one command.
#
# The binary is selectable, so a certbot installed without root works:
#   CERTBOT=~/.local/bin/certbot ./issue-cert.sh --ip-address 203.0.113.10 …
#
# Exit codes: 0 = ok, 1 = error
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

CERTBOT="${CERTBOT:-certbot}"
DOMAIN=""
IP_ADDRESS=""
EMAIL=""
SELF_SIGNED=false
RECREATE=false

while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="$2"; shift ;;
        --ip-address) IP_ADDRESS="$2"; shift ;;
        --email) EMAIL="$2"; shift ;;
        --self-signed) SELF_SIGNED=true ;;
        --recreate) RECREATE=true ;;
        --dry-run|--help|-h) : ;;
        *) die "unknown argument: $1" ;;
    esac
    shift
done

CERT_ROOT="${CERT_ROOT:-${INFRA_DIR}/certs}"
WEBROOT_DIR="${WEBROOT_DIR:-${INFRA_DIR}/certbot-www}"
CERT_DIR="${CERT_DIR:-${CERT_ROOT}/live/assetflow}"

if [ "$SELF_SIGNED" = true ] || { [ -z "$DOMAIN" ] && [ -z "$IP_ADDRESS" ]; }; then
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

ACME_ARGS=(
    certonly
    --webroot -w "$WEBROOT_DIR"
    --config-dir "$CERT_ROOT"
    --work-dir "${CERT_ROOT}/work"
    --logs-dir "${CERT_ROOT}/logs"
    --cert-name assetflow
    --email "$EMAIL"
    --agree-tos
    --no-eff-email
    --non-interactive
)
if [ -n "$DOMAIN" ]; then
    ACME_ARGS+=(-d "$DOMAIN")
fi
if [ -n "$IP_ADDRESS" ]; then
    # Forced by Let's Encrypt: a certificate naming an IP must be short-lived.
    ACME_ARGS+=(--ip-address "$IP_ADDRESS" --preferred-profile shortlived)
fi

REQUESTED="${DOMAIN:-}${IP_ADDRESS:-}"
[ -n "$DOMAIN" ] && [ -n "$IP_ADDRESS" ] && REQUESTED="${DOMAIN} + ${IP_ADDRESS}"
say "=== requesting a Let's Encrypt certificate for ${REQUESTED} ==="
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] ${CERTBOT} ${ACME_ARGS[*]}"
    exit 0
fi

# Checked after the dry-run branch on purpose: a machine without certbot can
# still preview exactly what would be run.
command -v "$CERTBOT" >/dev/null 2>&1 \
    || die "certbot not found (apt install certbot, or point CERTBOT at another binary)"

# An IP identifier is short-lived by policy and needs the webroot support that
# landed in 5.4. `sort -V` compares the versions correctly.
if [ -n "$IP_ADDRESS" ]; then
    CERTBOT_VERSION="$("$CERTBOT" --version 2>/dev/null | awk '{print $2}' || true)"
    if [ "$(printf '%s\n%s\n' "5.4" "${CERTBOT_VERSION:-0}" | sort -V | head -n1)" != "5.4" ]; then
        die "an IP certificate needs certbot >= 5.4 (webroot support for IP identifiers), found ${CERTBOT_VERSION:-unknown}"
    fi
fi

mkdir -p "$CERT_ROOT" "${CERT_ROOT}/work" "${CERT_ROOT}/logs" "$WEBROOT_DIR"

if [ "$RECREATE" = true ]; then
    say "deleting the existing lineage before re-issuing (the identifiers change)"
    "$CERTBOT" delete \
        --config-dir "$CERT_ROOT" \
        --work-dir "${CERT_ROOT}/work" \
        --logs-dir "${CERT_ROOT}/logs" \
        --cert-name assetflow \
        --non-interactive >/dev/null 2>&1 || warn "nothing to delete"
fi

# A self-signed bootstrap certificate is a plain directory; certbot wants
# `live/assetflow` to be its own symlink tree. Move the bootstrap aside. Nginx
# keeps serving the already-loaded certificate until the reload after issue.
if [ -d "$CERT_DIR" ] && [ ! -L "$CERT_DIR" ]; then
    BOOTSTRAP_DIR="${CERT_DIR}.bootstrap-$(date -u '+%Y%m%dT%H%M%SZ')"
    say "moving the bootstrap certificate to ${BOOTSTRAP_DIR}"
    mv "$CERT_DIR" "$BOOTSTRAP_DIR"
fi

export CERT_ROOT WEBROOT_DIR
"$CERTBOT" "${ACME_ARGS[@]}"

say "the certificate lives in ${CERT_DIR}"
say "renew it with: ${PWD}/${BASH_SOURCE[0]##*/} -> scripts/renew-cert.sh (daily; see infra/README.md)"
say "then reload nginx: docker compose -f infra/docker-compose.yml exec nginx nginx -s reload"

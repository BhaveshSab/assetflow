#!/usr/bin/env bash
#
# Renews the edge certificate and reloads Nginx when it actually changed.
#
# Why this exists: an **IP** certificate is only issued on Let's Encrypt's
# `shortlived` profile, which lives 160 hours (~6 days). A renewal that is
# remembered by hand is a padlock that disappears while nobody is looking, so
# this runs from cron once a day (see infra/README.md) and only touches Nginx
# when certbot actually wrote new files.
#
# Usage:
#   ./renew-cert.sh [--dry-run]
#
#   # a certbot installed without root
#   CERTBOT=~/.local/bin/certbot ./renew-cert.sh
#
# Exit codes: 0 = ok (renewed or nothing to do), 1 = error
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

CERTBOT="${CERTBOT:-certbot}"
CERT_ROOT="${CERT_ROOT:-${INFRA_DIR}/certs}"
WEBROOT_DIR="${WEBROOT_DIR:-${INFRA_DIR}/certbot-www}"
CERT_DIR="${CERT_DIR:-${CERT_ROOT}/live/assetflow}"

[ -f "${CERT_DIR}/fullchain.pem" ] \
    || die "no certificate at ${CERT_DIR} — run scripts/issue-cert.sh first"
command -v "$CERTBOT" >/dev/null 2>&1 \
    || die "certbot not found (apt install certbot, or point CERTBOT at another binary)"

if [ "$DRY_RUN" = true ]; then
    say "[dry-run] ${CERTBOT} renew --config-dir ${CERT_ROOT} --work-dir ${CERT_ROOT}/work --logs-dir ${CERT_ROOT}/logs"
    say "[dry-run] reload nginx if ${CERT_DIR}/fullchain.pem changed"
    exit 0
fi

mkdir -p "$WEBROOT_DIR"

# The mtime is how we know whether a reload is needed: `certbot renew` is
# silent when it has nothing to do, and reloading Nginx for no reason drops
# the keep-alive connections of live users.
BEFORE="$(stat -c %Y "${CERT_DIR}/fullchain.pem")"

say "=== renewing the certificate ==="
"$CERTBOT" renew \
    --config-dir "$CERT_ROOT" \
    --work-dir "${CERT_ROOT}/work" \
    --logs-dir "${CERT_ROOT}/logs" \
    --webroot -w "$WEBROOT_DIR" \
    --quiet

AFTER="$(stat -c %Y "${CERT_DIR}/fullchain.pem")"

if [ "$BEFORE" != "$AFTER" ]; then
    say "a new certificate was written — reloading nginx"
    compose exec -T nginx nginx -s reload
else
    say "the certificate is not due for renewal — nothing changed"
fi

# Always report what is actually being served, so a failed renewal is visible
# in the cron log instead of being discovered by a browser warning.
EXPIRY="$(openssl x509 -in "${CERT_DIR}/fullchain.pem" -noout -enddate | cut -d= -f2)"
DAYS="$(( ( $(date -d "$EXPIRY" +%s) - $(date +%s) ) / 86400 ))"
say "serving a certificate valid until ${EXPIRY} (${DAYS} day(s) left)"
if [ "$DAYS" -lt 2 ]; then
    die "the certificate expires in ${DAYS} day(s) — renewal is failing, read ${CERT_ROOT}/logs/"
fi

#!/bin/bash
#
# Generate the run's TLS trust material and bearer token, locally, before launch.
#
# WHY LOCAL AND NOT S3
# The capacity identity has an explicit Deny on s3:*, and the guest has no
# instance role. Publishing trust material to S3 would therefore require new
# infrastructure and new permissions. Generating it here instead means:
#   * no bucket, no instance role, no new AWS credentials;
#   * the operator already holds the certificate and token, which is exactly what
#     an evidence client needs;
#   * only the guest-side halves (cert + key + token) are rendered into user-data,
#     which is the provisioning path that already exists.
#
# THREAT MODEL - read before relying on this
# EC2 user-data is NOT a secret store. It is stored by AWS, readable by anything
# with ec2:DescribeInstanceAttribute on the instance and by any root process on
# the guest, and it is not encrypted. base64 is an encoding, not encryption. The
# material here is a short-lived, run-scoped credential for a disposable host, so
# that exposure is bounded and accepted - it is not suitable for production
# secrets, and none are placed here.
#
# The certificate uses a fixed DNS SAN (capacity-run.test) rather than the
# instance's public IP. The IP is only known after launch, so binding the cert to
# it would make the cert un-generatable in advance. The client instead maps the
# certified name to the real address with `curl --resolve`, which keeps BOTH CA
# verification and hostname verification intact.
#
# Usage
#   infra/capacity-run/generate-trust.sh <out-dir>
#
# Outputs (mode 0700 dir, 0600 files):
#   <out-dir>/tls.crt          - serve on the guest AND use as the client CA
#   <out-dir>/tls.key          - guest only
#   <out-dir>/evidence.token   - bearer token, shared guest+client
#   <out-dir>/trust.env        - the variables render-user-data.sh consumes
#
# Retention: the operator removes <out-dir> after the run. This script never
# touches anything outside the directory it is given.
set -euo pipefail

OUT="${1:?usage: generate-trust.sh <out-dir>}"
HOSTNAME="${CAPACITY_HOSTNAME:-capacity-run.test}"
DAYS="${CERT_DAYS:-2}"

umask 077
mkdir -p "$OUT"
chmod 700 "$OUT"

if [ -e "$OUT/tls.key" ] || [ -e "$OUT/evidence.token" ]; then
    echo "refusing to overwrite existing trust material in $OUT" >&2
    exit 2
fi

# 1. Certificate: fixed DNS SAN, no IP. Client maps the name to the address.
openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
    -keyout "$OUT/tls.key" -out "$OUT/tls.crt" \
    -subj "/CN=${HOSTNAME}" \
    -addext "subjectAltName=DNS:${HOSTNAME}" \
    -addext "basicConstraints=critical,CA:TRUE" \
    >/dev/null 2>&1
chmod 600 "$OUT/tls.key" "$OUT/tls.crt"

# 2. Bearer token: 48 random bytes, base64, no whitespace.
head -c 48 /dev/urandom | base64 | tr -d '\n' > "$OUT/evidence.token"
chmod 600 "$OUT/evidence.token"

# 3. The variables the renderer consumes.
TOKEN_VALUE="$(cat "$OUT/evidence.token")"
{
    printf 'CAPACITY_HOSTNAME=%s\n' "$HOSTNAME"
    printf 'EVIDENCE_TOKEN=%s\n' "$TOKEN_VALUE"
    printf 'TLS_CRT_B64=%s\n' "$(base64 -w0 "$OUT/tls.crt")"
    printf 'TLS_KEY_B64=%s\n' "$(base64 -w0 "$OUT/tls.key")"
} > "$OUT/trust.env"
chmod 600 "$OUT/trust.env"

# 4. Report only what is safe to print. Never echo the token or the key.
CRT_SHA="$(sha256sum "$OUT/tls.crt" | cut -d' ' -f1)"
echo "generated trust material in $OUT (mode 0700)"
echo "  hostname    : $HOSTNAME"
echo "  cert sha256 : $CRT_SHA"
echo "  SAN         : $(openssl x509 -in "$OUT/tls.crt" -noout -ext subjectAltName 2>/dev/null | tail -1 | tr -d ' ')"
echo "  token length: ${#TOKEN_VALUE} characters (value not printed)"
echo
echo "WARNING: /etc/capacity-run/run-config.env on the guest is readable by any"
echo "root process and by AWS APIs on this instance. It is not encrypted."

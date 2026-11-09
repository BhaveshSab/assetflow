#!/bin/bash
#
# Render the user-data payload for the capacity run.
#
# This is the ONE explicit provisioning path. Every input the guest needs is
# assembled here, on the operator machine, and embedded into the user-data
# payload as base64. Nothing is read from IMDS that could be wrong, and no AWS
# user credentials ever reach the guest.
#
# Secrets: the TLS key and bearer token are generated locally by
# generate-trust.sh and passed in through its trust.env. They are embedded in
# user-data, which is NOT a secret store - AWS stores it, it is readable via
# ec2:DescribeInstanceAttribute and by root on the guest, and base64 is an encoding
# rather than encryption. That is acceptable only because the material is
# short-lived and run-scoped. No AWS credentials and no production secrets go in.
#
# Usage
#   infra/capacity-run/generate-trust.sh .capacity-run-trust
#   set -a; . .capacity-run-trust/trust.env; set +a
#   LAUNCH_EPOCH=$(date +%s) EXPECTED_COMMIT=<sha> RUN_ID=cap-... \
#     infra/capacity-run/render-user-data.sh > user-data.b64
#
# Keep the output file out of Git: it contains the rendered key and token.
set -euo pipefail

: "${LAUNCH_EPOCH:?LAUNCH_EPOCH must be set to the intended launch instant}"
: "${EXPECTED_COMMIT:?EXPECTED_COMMIT must be the pinned SHA}"
: "${EVIDENCE_TOKEN:?EVIDENCE_TOKEN must be set (from generate-trust.sh)}"
: "${TLS_CRT_B64:?TLS_CRT_B64 must be set (from generate-trust.sh)}"
: "${TLS_KEY_B64:?TLS_KEY_B64 must be set (from generate-trust.sh)}"
: "${RUN_ID:?RUN_ID must be set}"
: "${CAPACITY_HOSTNAME:=capacity-run.test}"

if [ "${#EVIDENCE_TOKEN}" -lt 32 ]; then
    echo "EVIDENCE_TOKEN must be at least 32 characters" >&2
    exit 2
fi

# Long-lived AWS credentials must never be rendered onto the guest.
for forbidden in AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_ACCESS_KEY_ID; do
    eval "present=\${$forbidden:-}"
    if [ -n "${present:-}" ]; then
        echo "refusing to embed $forbidden: no AWS credentials on the guest" >&2
        exit 3
    fi
done

case "$LAUNCH_EPOCH" in
    ''|*[!0-9]*) echo "LAUNCH_EPOCH must be a unix timestamp" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

{
    cat <<PROLOGUE
#!/bin/bash
set -e
mkdir -p /etc/capacity-run
chmod 700 /etc/capacity-run

# Trust material supplied by the operator. Installed before the bootstrap runs so
# the evidence endpoint can start with a certificate the client already trusts.
echo '${TLS_CRT_B64}' | base64 -d > /etc/capacity-run/tls.crt
echo '${TLS_KEY_B64}' | base64 -d > /etc/capacity-run/tls.key
chmod 600 /etc/capacity-run/tls.key /etc/capacity-run/tls.crt

cat > /etc/capacity-run/run-config.env <<'CAPCONFIG'
LAUNCH_EPOCH=${LAUNCH_EPOCH}
EXPECTED_COMMIT=${EXPECTED_COMMIT}
EVIDENCE_TOKEN=${EVIDENCE_TOKEN}
CAPACITY_HOSTNAME=${CAPACITY_HOSTNAME}
RUN_ID=${RUN_ID}
FIXTURE_USERS=${FIXTURE_USERS:-200}
CAPCONFIG
chmod 600 /etc/capacity-run/run-config.env
PROLOGUE
    echo
    cat "$HERE/user-data.sh"
} | base64

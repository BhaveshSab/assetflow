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
# The compose file has no defaults for these; without them the stack cannot
# start at all, so rendering without them is a hard error.
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set (generate-app-config.sh)}"
: "${REDIS_PASSWORD:?REDIS_PASSWORD must be set (generate-app-config.sh)}"
: "${GRAFANA_ADMIN_PASSWORD:?GRAFANA_ADMIN_PASSWORD must be set}"
: "${JWT_SECRET:?JWT_SECRET must be set (generate-app-config.sh)}"
: "${LOADTEST_PASSWORD:?LOADTEST_PASSWORD must be set: the seed refuses >1 account without it}"
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
# Remove whole-line comments and blank lines from a shell script. Single-quoted
    # heredoc bodies inside the script are preserved verbatim, because those are
    # content (unit files, env files), not commentary.
    strip_comments() {
        awk '
            /^[[:space:]]*<<'"'"'?[A-Za-z_][A-Za-z_0-9]*'"'"'?[[:space:]]*$/ { inheredoc=1; print; next }
            inheredoc && /^[[:space:]]*[A-Za-z_][A-Za-z_0-9]*[[:space:]]*$/ {
                if ($0 ~ /^[[:space:]]*(UNIT|ENVEOF|GUARDEOF|CAPCONFIG)[[:space:]]*$/) { inheredoc=0 }
                print; next
            }
            inheredoc { print; next }
            /^[[:space:]]*#/ { next }
            /^[[:space:]]*$/ { next }
            { print }
        ' "$1"
    }
    GUARD_B64_DECODED="$(strip_comments "$HERE/deadline-guard.sh")"

{
    cat <<PROLOGUE
#!/bin/bash
set -e

# The prelude runs before the bootstrap has a log file, a say(), or a die().
# Without this, a failure in these first lines aborts under set -e and leaves no
# message anywhere - which is exactly what made one run look like an unexplained
# four-minute termination with an empty console. Report to /dev/console, which
# does not depend on the root volume, the journal, or the bootstrap's own logging.
prelude_fail() {
    rc=\$?
    msg="prelude failed (rc=\$rc) at line \$1"
    printf 'capacity-bootstrap: %s\\n' "\$msg" > /dev/console 2>/dev/null || true
    echo "[bootstrap][FATAL] \$msg" >&2
    exit "\$rc"
}
trap 'prelude_fail \$LINENO' ERR

echo "capacity-bootstrap: prelude start" > /dev/console 2>/dev/null || true
mkdir -p /etc/capacity-run
chmod 700 /etc/capacity-run

# Trust material supplied by the operator. Installed before the bootstrap runs so
# the evidence endpoint can start with a certificate the client already trusts.
echo '${TLS_CRT_B64}' | base64 -d > /etc/capacity-run/tls.crt
echo '${TLS_KEY_B64}' | base64 -d > /etc/capacity-run/tls.key
chmod 600 /etc/capacity-run/tls.key /etc/capacity-run/tls.crt

# The deadline guard is embedded rather than cloned, because the deadline must
# be armed before any network or package work can fail.
mkdir -p /usr/local/lib/capacity-run-src
cat > /usr/local/lib/capacity-run-src/deadline-guard.sh <<'GUARDEMBED'
${GUARD_B64_DECODED}
GUARDEMBED
chmod 755 /usr/local/lib/capacity-run-src/deadline-guard.sh

cat > /etc/capacity-run/run-config.env <<'CAPCONFIG'
LAUNCH_EPOCH=${LAUNCH_EPOCH}
EXPECTED_COMMIT=${EXPECTED_COMMIT}
EVIDENCE_TOKEN=${EVIDENCE_TOKEN}
CAPACITY_HOSTNAME=${CAPACITY_HOSTNAME}
RUN_ID=${RUN_ID}
FIXTURE_USERS=${FIXTURE_USERS:-200}
POSTGRES_USER=${POSTGRES_USER:-assetflow}
POSTGRES_DB=${POSTGRES_DB:-assetflow}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
GRAFANA_ADMIN_USER=${GRAFANA_ADMIN_USER:-admin}
GRAFANA_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
JWT_SECRET=${JWT_SECRET}
LOADTEST_PASSWORD=${LOADTEST_PASSWORD}
HTTP_PORT=${HTTP_PORT:-8080}
HTTPS_PORT=${HTTPS_PORT:-8443}
CAPCONFIG
chmod 600 /etc/capacity-run/run-config.env
PROLOGUE
    echo
    # Comments are stripped from the payload only. EC2 caps user-data at 16 KiB
    # raw and the annotated sources exceed that; the explanations live in the
    # repo, not on the instance.
    strip_comments "$HERE/user-data.sh"
} | base64

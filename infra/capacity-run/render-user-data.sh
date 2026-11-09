#!/bin/bash
#
# Render the user-data payload for the capacity run.
#
# This is the ONE explicit provisioning path. Every input the guest needs is
# written into /etc/capacity-run/run-config.env here, on the operator machine, and
# that file is embedded into user-data as base64. Nothing is read from IMDS that
# could be wrong, and no AWS user credentials ever reach the guest.
#
# The launch deadline is provisioned here because the operator, at render time, is
# the only party that knows when the instance will launch. The guest cannot forge
# or extend it: it is written into the payload before the instance exists.
#
# Usage
#   LAUNCH_EPOCH=$(date +%s) \
#   EXPECTED_COMMIT=<sha> \
#   EVIDENCE_TOKEN=<>=32 chars> \
#   S3_BUCKET=<bucket> \
#   RUN_ID=cap-... \
#   infra/capacity-run/render-user-data.sh > user-data.b64
#
# The output is base64 of a shell script, which is what `run-instances
# --user-data file://...` expects (raw text is also accepted; base64 avoids
# whitespace mangling by the shell).
#
# Refuses to run if any required input is missing, and refuses to embed anything
# that looks like a long-lived AWS credential.
set -euo pipefail

: "${LAUNCH_EPOCH:?LAUNCH_EPOCH must be set to the intended launch instant (unix seconds)}"
: "${EXPECTED_COMMIT:?EXPECTED_COMMIT must be the pinned SHA}"
: "${EVIDENCE_TOKEN:?EVIDENCE_TOKEN must be set (>= 32 chars)}"
: "${S3_BUCKET:?S3_BUCKET must be set}"
: "${RUN_ID:?RUN_ID must be set}"

# The token is served to the client, so it must be long enough to resist guessing.
if [ "${#EVIDENCE_TOKEN}" -lt 32 ]; then
    echo "EVIDENCE_TOKEN must be at least 32 characters" >&2
    exit 2
fi

# Only the run-scoped token goes in. Long-lived AWS credentials must not.
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
cat > /etc/capacity-run/run-config.env <<'CAPCONFIG'
LAUNCH_EPOCH=${LAUNCH_EPOCH}
EXPECTED_COMMIT=${EXPECTED_COMMIT}
EVIDENCE_TOKEN=${EVIDENCE_TOKEN}
S3_BUCKET=${S3_BUCKET}
RUN_ID=${RUN_ID}
FIXTURE_USERS=${FIXTURE_USERS:-200}
CAPCONFIG
chmod 600 /etc/capacity-run/run-config.env
PROLOGUE
    echo
    # The bootstrap body follows, so the payload is self-contained.
    cat "$HERE/user-data.sh"
} | base64

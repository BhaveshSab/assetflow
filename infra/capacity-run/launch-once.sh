#!/usr/bin/env bash
#
# Launch exactly one capacity instance, with an idempotency token that survives
# a lost response.
#
# WHY THIS IS A SCRIPT AND NOT INLINE WORKFLOW SHELL
# Inline shell in a workflow cannot be executed or tested without pushing a
# commit and watching a run, so mistakes in it are found at the worst moment:
# during the one permitted launch. Here it can be run against a fake CLI.
#
# WHY THE TOKEN IS PERSISTED FIRST
# `run-instances` can create an instance and still fail to return its id - a
# dropped connection, a proxy timeout, an interrupted runner. Treating an absent
# id as "nothing was created" is how a second call silently creates a SECOND
# instance. So the token is written to disk before the call, and an uncertain
# response is reconciled by asking EC2 what that token created.
#
# Usage
#   launch-once.sh --user-data FILE --token-file FILE --out FILE [--dry-run]
#
# Exit status
#   0  an instance id was determined (launched now, or reconciled from the token)
#   1  the launch failed and EC2 confirms the token created nothing
#   2  usage error
#   3  the response was uncertain and could not be reconciled - do NOT retry
set -uo pipefail

USER_DATA=""
TOKEN_FILE=""
OUT=""
DRY_RUN=0
register=0

while [ $# -gt 0 ]; do
    case "$1" in
        --user-data) USER_DATA="${2:?}"; shift 2 ;;
        --token-file) TOKEN_FILE="${2:?}"; shift 2 ;;
        --out) OUT="${2:?}"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --register-dry-run) DRY_RUN=1; register=1; shift ;;
        *) echo "launch-once: unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$USER_DATA" ] && [ -n "$TOKEN_FILE" ] && [ -n "$OUT" ] || {
    echo "launch-once: --user-data, --token-file and --out are required" >&2; exit 2; }

: "${RUN_ID:?RUN_ID must be set}"
: "${AMI_ID:?AMI_ID must be set}"
: "${SUBNET_ID:?SUBNET_ID must be set}"
: "${SG_ID:?SG_ID must be set}"
: "${INSTANCE_TYPE:=t3.micro}"

. "$(dirname "${BASH_SOURCE[0]}")/aws-context.sh"

# The raw payload must be a shell script. Base64 text here would boot an instance
# that does nothing and reports nothing.
[ "$(head -1 "$USER_DATA")" = "#!/bin/bash" ] || {
    echo "launch-once: user data is not raw shell (first line: $(head -1 "$USER_DATA"))" >&2
    exit 2
}
RAW_BYTES=$(wc -c < "$USER_DATA")
if [ "$RAW_BYTES" -gt 16384 ]; then
    echo "launch-once: user data is $RAW_BYTES bytes, over the 16384 limit" >&2
    exit 2
fi
echo "launch-once: user data $RAW_BYTES bytes raw, starts with #!/bin/bash"

# ---- idempotency token, persisted BEFORE the call -------------------------
# A fresh token per attempt. It is written and flushed first, so a crash between
# here and the response still leaves the means to reconcile.
if [ -s "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE")
    REUSED=1
else
    TOKEN="cap-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
    ( umask 077; printf '%s' "$TOKEN" > "$TOKEN_FILE"; sync )
    REUSED=0
fi
echo "launch-once: idempotency token ${TOKEN}${REUSED:+ (reused from a previous call)}"

# Reconcile: what does EC2 say this token created? Works before and after a call,
# because ClientToken is a real filter on DescribeInstances.
reconcile() {
    cap_aws ec2 describe-instances \
        --filters "Name=client-token,Values=$TOKEN" \
        --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output text 2>/dev/null
}

ARGS=(
    ec2 run-instances
    --image-id "$AMI_ID"
    --instance-type "$INSTANCE_TYPE"
    --subnet-id "$SUBNET_ID"
    --security-group-ids "$SG_ID"
    --credit-specification CpuCredits=standard
    --block-device-mappings "DeviceName=${ROOT_DEVICE:-/dev/sda1},Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}"
    --instance-initiated-shutdown-behavior terminate
    --client-token "$TOKEN"
    --tag-specifications
        "ResourceType=instance,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=$RUN_ID}]"
        "ResourceType=volume,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=$RUN_ID}]"
        "ResourceType=network-interface,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=$RUN_ID}]"
    --user-data "file://$USER_DATA"
    --query 'Instances[0].InstanceId' --output text
)
# --key-name is omitted entirely rather than --no-key-name: the flag does not
# exist on older CLI versions, and an unrecognised flag aborts the launch.

if [ "$DRY_RUN" -eq 1 ]; then
    ARGS+=(--dry-run)
fi

if [ "$register" -eq 1 ]; then
    # The dry-run form of run-instances does not accept --dry-run through the
    # CLI's own dry-run registration, so this is only used by tests.
    :
fi

set +e
RESPONSE=$(cap_aws "${ARGS[@]}" 2>"$OUT.err")
RC=$?
set -e
cp "$OUT.err" "$OUT.err.kept" 2>/dev/null || true

if [ "$DRY_RUN" -eq 1 ]; then
    if [ $RC -eq 0 ] || grep -q 'DryRunOperation' "$OUT.err"; then
        echo "launch-once: dry-run accepted (request would have succeeded)"
        exit 0
    fi
    echo "launch-once: dry-run refused:" >&2
    sed 's/Encoded authorization.*//' "$OUT.err" | head -3 >&2
    exit 1
fi

FOUND=$(reconcile)
if [ -n "$FOUND" ]; then
    ID=$(printf '%s\n' "$FOUND" | awk '{print $1}' | head -1)
    printf '%s' "$ID" > "$OUT"
    echo "launch-once: reconciled instance $ID from token $TOKEN"
    exit 0
fi

if [ $RC -eq 0 ] && [ -n "$RESPONSE" ] && [ "$RESPONSE" != "None" ]; then
    printf '%s' "$RESPONSE" > "$OUT"
    echo "launch-once: launched $RESPONSE"
    exit 0
fi

if [ $RC -ne 0 ]; then
    echo "launch-once: run-instances failed and token $TOKEN created nothing:" >&2
    sed 's/Encoded authorization.*//' "$OUT.err" | head -5 >&2
    exit 1
fi

# Neither a returned id nor a reconciled instance, but no error either.
echo "launch-once: response was uncertain and token $TOKEN reconciles to nothing." >&2
echo "launch-once: do NOT retry blindly - inspect by client token first." >&2
exit 3

#!/usr/bin/env bash
#
# Inventory sweep for the capacity run.
#
# Two defects this replaces, both found in review:
#
#  1. The old loop used `length(Reservations)` for both instances and volumes.
#     `describe-volumes` has no Reservations member, so the volume count was an
#     error printed as a number.
#  2. Errors were hidden with `2>/dev/null || echo 0`, so a failed or denied call
#     was indistinguishable from "no resources". That is how a security group was
#     reported as absent while it existed.
#
# Here every query names its own array, any error aborts loudly, and terminated
# instances are excluded from the active count.
set -euo pipefail

PROFILE="${AWS_PROFILE:-capacity}"
REGION="${AWS_REGION:-ap-southeast-2}"
RUN_ID="${RUN_ID:-cap-20261109t0800z-a7f3}"

# Fail on any unset variable, and never swallow an AWS error.
if ! aws --profile "$PROFILE" --region "$REGION" sts get-caller-identity >/dev/null; then
    echo "FATAL: cannot authenticate; refusing to report counts" >&2
    exit 2
fi

count_() {  # count_ <describe-subcommand> <resource-array> <extra-filters...>
    local sub="$1" arr="$2"; shift 2
    local out
    if ! out="$(aws --profile "$PROFILE" --region "$REGION" ec2 "$sub" \
        --filters "Name=tag:RunId,Values=${RUN_ID}" "$@" \
        --query "length(${arr})" --output text 2>&1)"; then
        echo "FATAL: describe-${sub} failed: ${out}" >&2
        exit 3
    fi
    printf '%s' "$out"
}

echo "run-owned resources for ${RUN_ID}"

# Instances: split by state, so a terminated-but-not-yet-vanished instance is
# visible but not counted as active. Terminated instances keep their tags for a
# while, so filtering alone would overcount.
instances_json="$(aws --profile "$PROFILE" --region "$REGION" ec2 describe-instances \
    --filters "Name=tag:RunId,Values=${RUN_ID}" \
    --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output text 2>&1)" \
    || { echo "FATAL: describe-instances failed: ${instances_json}" >&2; exit 3; }

active_instances="$(printf '%s\n' "$instances_json" | awk '$2!="terminated"' | grep -c . || true)"
terminated_instances="$(printf '%s\n' "$instances_json" | awk '$2=="terminated"' | grep -c . || true)"

echo "  instances active     : ${active_instances:-0}"
echo "  instances terminated : ${terminated_instances:-0}   (tagged, not billed for compute)"

# Volumes: their own array. A volume is billed whether or not an instance exists.
echo "  volumes              : $(count_ describe-volumes Volumes)"

# Security groups: their own array again.
echo "  security groups      : $(count_ describe-security-groups SecurityGroups)"

# Public IPv4: billed per hour while associated.
echo "  elastic/public IPv4  : $(count_ describe-addresses Addresses)"

echo
echo "Expectation after teardown: active 0, volumes 0, security groups 0, addresses 0."
echo "Terminated instances may still be listed; they are not billable for compute."

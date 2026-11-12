#!/usr/bin/env bash
#
# Hold this runner for a possible Stage 4 approval.
#
# Retaining the INSTANCE is not enough for Stage 4. The runner's own public
# address is the only address allowed through tcp/8443, and its private CA,
# token and state are the only things that can verify the run's TLS. If the job
# exits, the runner is destroyed and all three are lost - the retained instance
# becomes unreachable and unusable. So the job, not just the instance, is held.
#
# Bounded three ways, in this order:
#   1. STAGE4_HOLD_MINUTES (default 45) - a non-number is an error, not a skip.
#   2. a hard cap of 120 minutes, so a fat-fingered variable can never hold the
#      runner past the instance's own 4-hour lifetime.
#   3. the run's absolute guest deadline, minus a 5-minute margin.
#
# No AWS service or permission is involved beyond reading the instance state:
# this is a wait inside the job that is already running. The AWS call is made
# with the same explicit profile and region every other call uses, so an
# ambient default profile can never be consulted.
#
# Environment:
#   STATE_DIR     required. Holds instance-id, deadline-epoch, ingress-cidr;
#                 hold-window is written here.
#   HOLD_MINUTES  required. Minutes to hold, capped at 120.
#   CAP_PROFILE   required. AWS profile name.
#   CAP_REGION    required. AWS region.
set -euo pipefail

STATE_DIR="${STATE_DIR:?STATE_DIR is required}"
HOLD_MINUTES="${HOLD_MINUTES:?HOLD_MINUTES is required}"
CAP_PROFILE="${CAP_PROFILE:?CAP_PROFILE is required}"
CAP_REGION="${CAP_REGION:?CAP_REGION is required}"

[[ "$HOLD_MINUTES" =~ ^[0-9]+$ ]] || {
    echo "::error title=hold::STAGE4_HOLD_MINUTES is not a number" >&2
    exit 1
}
[ "$HOLD_MINUTES" -le 120 ] || HOLD_MINUTES=120

INSTANCE_ID=$(cat "$STATE_DIR/instance-id" 2>/dev/null || echo unknown)
DEADLINE=$(cat "$STATE_DIR/deadline-epoch" 2>/dev/null || echo 0)

END=$(( $(date +%s) + HOLD_MINUTES * 60 ))
if [ "$DEADLINE" -gt 0 ] && [ "$END" -gt "$DEADLINE" ]; then
    END=$(( DEADLINE - 300 ))
fi

echo "hold-until-epoch=$END" > "$STATE_DIR/hold-window"
echo "Holding for $HOLD_MINUTES minutes (max 120), bounded by the guest deadline."
echo "Retained instance: $INSTANCE_ID"
echo "The runner stays alive until $END. Start Stage 4 within this window;"
echo "afterwards the guest terminates itself at its deadline."

while [ "$(date +%s)" -lt "$END" ]; do
    ST=$(aws --profile "$CAP_PROFILE" --region "$CAP_REGION" \
        ec2 describe-instances --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null \
        || echo unknown)
    if [ "$ST" = "terminated" ] || [ "$ST" = "shutting-down" ]; then
        echo "instance is $ST; the hold ends here"
        exit 0
    fi
    sleep 60
done
echo "hold window closed"

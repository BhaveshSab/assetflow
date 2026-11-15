#!/bin/bash
#
# Operator-side CloudWatch collector for the capacity run.
#
# The guest cannot do this: it has no AWS CLI and no instance role, and putting an
# AWS user's credentials on it is exactly what must not happen. CPU credit balance
# is therefore read from the operator machine with the existing `capacity` profile,
# and the result is written into the evidence bundle the operator keeps.
#
# Why credits matter: a t3.micro earns credits at a fixed rate and bursts from a
# balance. When the balance hits zero the instance is throttled to baseline, so a
# saturation measurement that ignored credits would be measuring the wrong thing.
#
# Sampling: CloudWatch's finest standard-resolution granularity for these metrics
# is 60 s, and the metric is published at 5-minute resolution for basic monitoring.
# This script therefore samples at 60 s and records the *datapoint timestamps*
# returned by AWS, so the caller can see the real granularity rather than assume
# the sample rate equals the metric rate.
set -uo pipefail

INSTANCE_ID="${1:?usage: collect-credits.sh <instance-id> [output-file]}"
OUT="${2:-credits.jsonl}"
PROFILE="${AWS_PROFILE:-capacity}"
REGION="${AWS_REGION:-ap-southeast-2}"
DURATION="${CREDIT_DURATION:-14400}"   # 4 h
INTERVAL="${CREDIT_INTERVAL:-60}"

end_time() { date -u +%Y-%m-%dT%H:%M:%SZ; }
start_time() { date -u -d "@$(( $(date +%s) - DURATION ))" +%Y-%m-%dT%H:%M:%SZ; }

fetch() {  # fetch <metric-name>
    local metric="$1"
    aws --profile "$PROFILE" --region "$REGION" cloudwatch get-metric-statistics \
        --namespace AWS/EC2 --metric-name "$metric" \
        --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
        --start-time "$(start_time)" --end-time "$(end_time)" \
        --period 300 --statistics Average Minimum Maximum \
        --query 'Datapoints[].[Timestamp,Average,Minimum,Maximum]' \
        --output text 2>&1
}

emit() {
    local ts credits_bal cpu_util
    ts="$(end_time)"

    credits_bal="$(fetch CPUCreditBalance)"
    cpu_util="$(fetch CPUUtilization)"

    # A failed call is recorded as an error, never as a healthy zero.
    if printf '%s' "$credits_bal" | grep -qi 'error\|denied\|unable'; then
        printf '{"ts":"%s","metric":"CPUCreditBalance","error":%s}\n' \
            "$ts" "$(printf '%s' "$credits_bal" | head -1 | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" >> "$OUT"
    else
        printf '%s\n' "$credits_bal" | while IFS=$'\t' read -r stamp avg mn mx; do
            [ -n "${stamp:-}" ] || continue
            printf '{"sample_ts":"%s","metric":"CPUCreditBalance","datapoint_ts":"%s","avg":"%s","min":"%s","max":"%s"}\n' \
                "$ts" "$stamp" "$avg" "$mn" "$mx" >> "$OUT"
        done
    fi

    if printf '%s' "$cpu_util" | grep -qi 'error\|denied\|unable'; then
        printf '{"ts":"%s","metric":"CPUUtilization","error":"fetch failed"}\n' "$ts" >> "$OUT"
    else
        printf '%s\n' "$cpu_util" | while IFS=$'\t' read -r stamp avg mn mx; do
            [ -n "${stamp:-}" ] || continue
            printf '{"sample_ts":"%s","metric":"CPUUtilization","datapoint_ts":"%s","avg":"%s","min":"%s","max":"%s"}\n' \
                "$ts" "$stamp" "$avg" "$mn" "$mx" >> "$OUT"
        done
    fi
}

if [ "${CREDIT_ONCE:-0}" = "1" ]; then
    emit
    exit 0
fi

while true; do
    emit
    sleep "$INTERVAL"
done

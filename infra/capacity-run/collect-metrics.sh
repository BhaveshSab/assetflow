#!/usr/bin/env bash
#
# Host metrics for the capacity run, written for the evidence endpoint to serve.
#
# This exists because the readiness and saturation evidence has to be readable
# WITHOUT SSH: the instance has no key pair. Everything here lands as a file in
# the evidence directory, which the operator fetches over the approved 443 path.
#
# Sample cadence is deliberately coarse (10s). The run is minutes long and the
# interesting signals - RSS against a 1 GB host, CPU credit balance - move on the
# order of seconds, not milliseconds.
set -euo pipefail

RUN_DIR="${RUN_DIR:-/var/lib/capacity-run}"
OUT="$RUN_DIR/evidence/host-metrics.jsonl"
INTERVAL="${METRICS_INTERVAL:-10}"

mkdir -p "$(dirname "$OUT")"

emit() {
    local ts rss_mb swap_used credits
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    # Sum of RSS across the app processes, in MB. This is the memory gate from
    # the readiness checks: it must stay under 70% of 1024 MB before the ramp.
    rss_mb="$(ps -eo rss=,args= \
        | grep -E 'node|postgres|nginx' \
        | grep -v grep \
        | awk '{s+=$1} END {printf "%d", s/1024}' || echo 0)"

    swap_used="$(free -m | awk '/Swap:/ {print $3}' || echo 0)"
    credits="$(/usr/bin/aws cloudwatch get-metric-statistics --namespace AWS/EC2 \
        --metric-name CPUCreditBalance --dimensions Name=InstanceId,Value="$(curl -fsS -H "X-aws-ec2-metadata-token: $(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null)" \
        --start-time "$(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" \
        --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --period 300 --statistics Average \
        --query 'Datapoints[0].Average' --output text 2>/dev/null || echo unknown)"

    printf '{"ts":"%s","rss_mb":%s,"swap_used_mb":%s,"cpu_credit_balance":"%s"}\n' \
        "$ts" "$rss_mb" "$swap_used" "$credits" >> "$OUT"

    # Lifecycle status, so readiness can prove the deadline without touching the guest.
    systemctl is-active capacity-deadline.timer > "$RUN_DIR/evidence/timer-state" 2>/dev/null || true
    cat "$RUN_DIR/deadline-epoch" > "$RUN_DIR/evidence/deadline-epoch" 2>/dev/null || true
    cat "$RUN_DIR/bootstrap-status" > "$RUN_DIR/evidence/bootstrap-status" 2>/dev/null || true
    cat "$RUN_DIR/deployed-commit" > "$RUN_DIR/evidence/deployed-commit" 2>/dev/null || true
}

while true; do
    emit || true
    sleep "$INTERVAL"
done

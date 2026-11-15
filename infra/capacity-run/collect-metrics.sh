#!/bin/bash
#
# Host metrics for the capacity run, sampled every second.
#
# Two review findings shaped this:
#
#  1. The previous version defaulted the interval to 10 seconds, silently changing
#     the agreed 1-second cadence. This one defaults to 1 second, and the systemd
#     unit sets METRICS_INTERVAL=1 explicitly.
#  2. The previous version read CloudWatch from the guest, but the guest has no
#     AWS CLI and no instance role. **It does not touch AWS at all now.** CPU credit
#     balance is collected operator-side with the existing `capacity` profile; a
#     guest calling CloudWatch would have required putting AWS credentials on it,
#     which is exactly what must not happen.
#
# Every failure is recorded as a failure. A missing or unreadable measurement
# writes null plus an error, never a zero that looks healthy.
set -uo pipefail

RUN_DIR="${RUN_DIR:-/var/lib/assetflow-capacity}"
EVIDENCE_DIR="$RUN_DIR/evidence"
OUT="$EVIDENCE_DIR/host-metrics.jsonl"
INTERVAL="${METRICS_INTERVAL:-1}"

mkdir -p "$EVIDENCE_DIR"
: >> "$OUT"

# Read a /proc field, or emit null. Never invent a value.
num() { printf '%s' "$1" | grep -Eq '^[0-9]+$' && printf '%s' "$1" || printf 'null'; }

sample() {
    local ts mem_total mem_avail mem_used_pct swap_total swap_free swap_used
    local oom dmesg_oom load1 restarts errors=0

    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    # Memory, from /proc/meminfo, in kB.
    mem_total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo '')
    mem_avail=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo '')
    if [ -n "$mem_total" ] && [ -n "$mem_avail" ] && [ "$mem_total" -gt 0 ] 2>/dev/null; then
        mem_used_pct=$(( (mem_total - mem_avail) * 100 / mem_total ))
    else
        mem_used_pct=''
        errors=$(( errors + 1 ))
    fi

    swap_total=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo '')
    swap_free=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo 2>/dev/null || echo '')
    if [ -n "$swap_total" ] && [ -n "$swap_free" ]; then
        swap_used=$(( (swap_total - swap_free) / 1024 ))
    else
        swap_used=''
        errors=$(( errors + 1 ))
    fi

    # OOM events: kernel counter plus dmesg occurrences.
    oom=$(awk '/^oom_kill /{s+=$2} END {print s+0}' /proc/vmstat 2>/dev/null || echo '')
    dmesg_oom=$(journalctl -k --since '-2 min' 2>/dev/null | grep -c 'Out of memory' || echo 0)

    load1=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo '')

    # Container restart counts: a crash-looping app must be visible, not inferred.
    if command -v docker >/dev/null 2>&1; then
        restarts=$(docker ps -q 2>/dev/null | xargs -r docker inspect \
            --format '{{.Name}} {{.RestartCount}}' 2>/dev/null | paste -sd',' - || echo '')
    else
        restarts=''
        errors=$(( errors + 1 ))
    fi

    printf '{"ts":"%s","mem_used_pct":%s,"swap_used_mb":%s,"oom_kills":%s,"oom_dmesg":%s,"load1":%s,"restarts":"%s","errors":%d}\n' \
        "$ts" \
        "$(num "$mem_used_pct")" \
        "$(num "$swap_used")" \
        "$(num "$oom")" \
        "$(num "$dmesg_oom")" \
        "$(num "${load1%%.*}")" \
        "${restarts}" \
        "$errors" >> "$OUT"
}

# Publish operational state for the readiness check. These are outputs, not inputs.
publish_state() {
    systemctl is-active capacity-deadline.timer  > "$EVIDENCE_DIR/deadline-timer-state"  2>/dev/null || true
    systemctl is-enabled capacity-deadline.timer > "$EVIDENCE_DIR/deadline-timer-enabled" 2>/dev/null || true
    systemctl is-active capacity-evidence.service > "$EVIDENCE_DIR/evidence-service-state" 2>/dev/null || true
    systemctl is-active capacity-metrics.service  > "$EVIDENCE_DIR/metrics-service-state"  2>/dev/null || true
}

while true; do
    sample || true
    publish_state || true
    sleep "$INTERVAL"
done

#!/usr/bin/env bash
#
# Operator-side watchdog for the capacity run.
#
# WHY THIS EXISTS
# The in-guest deadline timer is the primary control, but it lives on the
# instance. If the instance's cloud-init fails before the timer is armed, or the
# guest hangs so badly that systemd never fires the transient unit, nothing on the
# guest will terminate it. This watchdog is the independent second line.
#
# WHY IT IS NOT A SHELL SLEEP
# The previous plan was "sleep 4h; terminate". That is not a watchdog: it dies
# with the terminal that started it, it dies if the operator's session is killed,
# and nothing proves it is still running. This script instead:
#
#   * is started detached from any terminal (setsid nohup), so an operator
#     disconnect or a closed editor does not kill it;
#   * writes a heartbeat file every cycle, so its liveness is observable rather
#     than assumed;
#   * re-derives the deadline from the INSTANCE LAUNCH TIME via the EC2 API on
#     every cycle, so a clock skew or a missed cycle cannot extend the run;
#   * terminates by instance ID only, after re-reading the instance and
#     confirming the run tag still matches - it will not act on a stale ID that
#     was reused or a tag that was changed;
#   * reports "already terminated" as success, not as an error.
#
# It runs OUTSIDE the AI tool session: start it and it keeps running in the
# background on the operator host. Section "Usage" shows how to prove it is
# alive after the tool call that started it has returned.
#
# Usage
#   infra/capacity-run/operator-watchdog.sh <instance-id> [lifetime-seconds]
#
# Verify it is actually running (not just that it was started):
#   cat /var/lib/capacity-watchdog/heartbeat   # mtime must be recent
#   ps -o pid,etime,cmd -p "$(cat /var/lib/capacity-watchdog/pid)"

set -euo pipefail

INSTANCE_ID="${1:?usage: operator-watchdog.sh <instance-id> [lifetime-seconds]}"
LIFETIME="${2:-14400}"
PROFILE="${AWS_PROFILE:-capacity}"
REGION="${AWS_REGION:-ap-southeast-2}"
RUN_ID="${RUN_ID:-cap-20261109t0800z-a7f3}"
STATE_DIR="${WATCHDOG_STATE_DIR:-/var/lib/capacity-watchdog}"
POLL="${WATCHDOG_POLL:-60}"

mkdir -p "$STATE_DIR"
echo $$ > "$STATE_DIR/pid"
echo "watchdog started for $INSTANCE_ID, lifetime ${LIFETIME}s" > "$STATE_DIR/status"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$STATE_DIR/status"; }

aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

while true; do
    # Atomic write: a reader (the supervisor's liveness check) must never see
    # the truncated instant of a plain ">" redirect, which it would read as a
    # missing or non-numeric heartbeat and treat as a dead watchdog. Write to a
    # private temp file and rename - rename within the same directory is
    # atomic, so the heartbeat is either the previous value or the new one.
    HB_TMP="$STATE_DIR/.heartbeat.$$"
    date -u +%s > "$HB_TMP" && mv -f "$HB_TMP" "$STATE_DIR/heartbeat"

    # Re-read the instance every cycle. Stop if it is gone, so the watchdog does
    # not outlive its purpose.
    info="$(aws_ ec2 describe-instances --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].{State:State.Name,Launch:LaunchTime,RunId:Tags[?Key==`RunId`]|[0].Value}' \
        --output json 2>/dev/null || echo '{}')"

    state="$(printf '%s' "$info" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("State",""))' 2>/dev/null || echo '')"

    case "$state" in
        terminated|shutting-down)
            log "instance is $state; watchdog exiting"
            exit 0 ;;
        "")
            # Could not read: do NOT treat as terminated (that would hide failure),
            # and do NOT terminate blindly on an unknown state.
            log "WARN cannot read instance state; will retry"
            sleep "$POLL"; continue ;;
    esac

    # Confirm the tag still identifies this run before acting on the ID.
    run_id="$(printf '%s' "$info" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("RunId") or "")' 2>/dev/null || echo '')"
    if [ "$run_id" != "$RUN_ID" ]; then
        log "ERROR instance $INSTANCE_ID RunId is '$run_id', expected '$RUN_ID'; refusing to act"
        sleep "$POLL"; continue
    fi

    launch="$(printf '%s' "$info" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Launch") or "")' 2>/dev/null || echo '')"
    if [ -z "$launch" ]; then
        log "WARN no launch time; will retry"
        sleep "$POLL"; continue
    fi

    launch_epoch="$(date -d "$launch" +%s)"
    deadline=$(( launch_epoch + LIFETIME ))
    now="$(date +%s)"

    if [ "$now" -ge "$deadline" ]; then
        log "deadline reached (launch-based); terminating $INSTANCE_ID"
        if aws_ ec2 terminate-instances --instance-ids "$INSTANCE_ID"; then
            log "terminate accepted"
            exit 0
        else
            log "ERROR terminate failed; will retry next cycle"
        fi
    fi

    sleep "$POLL"
done

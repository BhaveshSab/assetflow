#!/bin/bash
#
# Enforce the capacity run's absolute deadline.
#
# Invoked by capacity-deadline.timer on a schedule. The timer's service is a
# plain oneshot WITHOUT RemainAfterExit, so each timer tick really does start a
# new oneshot run. (With RemainAfterExit=yes the unit would stay "active" after
# the first check, systemd would consider it already started, and every later
# tick would be a no-op - the guard would run exactly once and then never again.)
#
# The deadline is an absolute instant recorded at bootstrap. It is never "now +
# 4 hours", so a restart or reboot cannot extend the window.
#
# VALIDATION. The file is validated as a WHOLE, not by stripping non-digits.
# `tr -dc '0-9'` would turn "17abc400" into "17400" and accept it as a valid
# timestamp, which is exactly the failure mode this guard exists to prevent. Any
# character outside [0-9] is a hard failure, and a malformed or missing deadline
# fails CLOSED: the guest shuts down rather than running unbounded.
#
# SHUTDOWN_BIN exists only so tests can substitute a harmless stub. In
# production it is /sbin/shutdown, and since the instance was launched with
# InstanceInitiatedShutdownBehavior=terminate, that TERMINATES the instance and
# deletes the root volume.
set -uo pipefail

RUN_DIR="${RUN_DIR:-/var/lib/assetflow-capacity}"
DEADLINE_FILE="${DEADLINE_FILE:-$RUN_DIR/evidence/deadline-epoch}"
STATUS_FILE="${STATUS_FILE:-$RUN_DIR/evidence/deadline-status}"
SHUTDOWN_BIN="${SHUTDOWN_BIN:-/sbin/shutdown}"

emit() { printf '%s\n' "$1" > "$STATUS_FILE" 2>/dev/null || true; }

shut_down() {
    # Write the reason before shutting down so the evidence archive explains it.
    emit "$1"
    printf '[deadline] %s - shutting down\n' "$1"
    "$SHUTDOWN_BIN" -h now || true
    exit 0
}

[ -r "$DEADLINE_FILE" ] || shut_down "failed: deadline-epoch unreadable"

# Read the raw value; do not trim characters. Only trailing newlines are
# removed, because a text file naturally ends with one.
DEADLINE_RAW="$(cat "$DEADLINE_FILE" 2>/dev/null)"
DEADLINE="${DEADLINE_RAW%$'\n'}"
DEADLINE="${DEADLINE%$'\r'}"

[ -n "$DEADLINE" ] || shut_down "failed: deadline-epoch empty"

# Whole-value validation: every character must be a digit.
case "$DEADLINE" in
    *[!0-9]*)
        shut_down "failed: deadline-epoch malformed (non-numeric: '${DEADLINE}')" ;;
esac

# Reject values too short to be a plausible unix timestamp. "17400" is all
# digits but is not a timestamp this run could have written.
if [ "${#DEADLINE}" -lt 9 ]; then
    shut_down "failed: deadline-epoch implausible (${#DEADLINE} digits: '${DEADLINE}')"
fi

NOW=$(date +%s)
if [ "$NOW" -ge "$DEADLINE" ]; then
    shut_down "deadline reached (deadline=$DEADLINE now=$NOW)"
fi

REMAINING=$(( DEADLINE - NOW ))
emit "ok remaining=${REMAINING}s"
printf '[deadline] %ss remaining (deadline %s)\n' "$REMAINING" "$DEADLINE"

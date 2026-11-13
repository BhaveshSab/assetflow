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

# Diagnostics go to the console as well as stdout. On the run that exposed this
# the journal died of "No space left on device", so journald was not a place a
# post-mortem could read from. /dev/console is independent of the root volume
# having free space and lands in the EC2 system log.
console_log() {
    printf '[deadline] %s\n' "$1"
    if [ -w /dev/console ]; then
        printf 'capacity-deadline: %s\n' "$1" > /dev/console 2>/dev/null || true
    fi
}

# Same contract as user-data.sh: record the reason, hold a bounded window for
# the off-host poller, then shut down. Fail-closed is preserved.
EW_SECONDS="${EW_SECONDS:-90}"
case "$EW_SECONDS" in ''|*[!0-9]*) EW_SECONDS=90 ;; esac
[ "$EW_SECONDS" -le 180 ] || EW_SECONDS=180

evidence_window() {
    console_log "evidence window ${EW_SECONDS}s open, then shutdown"
    sleep "$EW_SECONDS" || true
}

# Record the environment once per invocation so a failing unit explains itself
# without needing the journal: which deadline file, which value, what time is
# now, and what it is about to do.
console_log "run dir=$RUN_DIR deadline_file=$DEADLINE_FILE now=$(date +%s)"

shut_down() {
    # Write the reason before shutting down so the evidence archive explains it.
    emit "$1"
    console_log "SHUTDOWN: $1"
    evidence_window "$1"
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
console_log "${REMAINING}s remaining (deadline $DEADLINE)"

#!/bin/bash
#
# Deadline enforcement, run every 60s by capacity-deadline.timer.
#
# Why a polling guard rather than `systemd-run --on-active`: that creates a
# TRANSIENT unit, which does not survive a reboot. This unit is installed
# permanently and compares the CURRENT time against the ABSOLUTE deadline that
# the operator provisioned (LAUNCH_EPOCH + lifetime). A reboot therefore does not
# restart the clock - the deadline is a fixed instant, not a countdown.
#
# When the deadline passes, `shutdown -h now` runs. The instance was launched with
# InstanceInitiatedShutdownBehavior=terminate, so this terminates it and deletes
# the root volume. Termination (not stop) is what avoids leaving billable storage.
set -uo pipefail

RUN_DIR="${RUN_DIR:-/var/lib/assetflow-capacity}"
EVIDENCE_DIR="$RUN_DIR/evidence"
DEADLINE_FILE="$EVIDENCE_DIR/deadline-epoch"
# Absolute by default: PATH is attacker-controllable, so the real shutdown is
# never resolved through it. SHUTDOWN_BIN exists only so tests can observe the
# call without halting the machine.
SHUTDOWN_BIN="${SHUTDOWN_BIN:-/sbin/shutdown}"

# Fail closed: an absent or malformed deadline must not disable enforcement.
if [ ! -r "$DEADLINE_FILE" ]; then
    echo "deadline-epoch missing: cannot prove the deadline, terminating" \
        > "$EVIDENCE_DIR/deadline-status"
    "$SHUTDOWN_BIN" -h now
    exit 0
fi

DEADLINE=$(tr -dc '0-9' < "$DEADLINE_FILE")
case "$DEADLINE" in
    ''|*[!0-9]*) echo "deadline-epoch malformed ('$DEADLINE'): terminating" \
                     > "$EVIDENCE_DIR/deadline-status"
                 "$SHUTDOWN_BIN" -h now
                 exit 0 ;;
esac

NOW=$(date +%s)
if [ "$NOW" -ge "$DEADLINE" ]; then
    echo "deadline reached at $NOW (deadline $DEADLINE): terminating" \
        > "$EVIDENCE_DIR/deadline-status"
    "$SHUTDOWN_BIN" -h now
    exit 0
fi

echo "ok now=$NOW deadline=$DEADLINE remaining=$(( DEADLINE - NOW ))" \
    > "$EVIDENCE_DIR/deadline-status"

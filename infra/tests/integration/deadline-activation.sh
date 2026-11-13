#!/bin/bash
#
# Prove that the deadline guard really is re-activated by a repeating timer, and
# that a oneshot without RemainAfterExit is what makes that possible.
#
# This runs REAL systemd (.timer/.service, systemctl, journald) in the current
# environment. It substitutes a harmless stub for /sbin/shutdown so nothing is
# ever powered off, and it uses an isolated unit namespace prefix so it cannot
# disturb anything else on the host.
#
# It deliberately ALSO runs the broken variant (with RemainAfterExit=yes) and
# asserts that it activates only once. Without that control, a passing "it
# re-armed" result would not show that the fix is what caused it.
#
# Usage: deadline-activation.sh <repo-root>
set -uo pipefail

REPO="${1:?usage: deadline-activation.sh <repo-root>}"
WORK="$(mktemp -d)"
STUB_LOG="$WORK/shutdown-calls.log"
GUARD="$REPO/infra/capacity-run/deadline-guard.sh"

cleanup() {
    systemctl --user stop capdl-ok.timer capdl-bad.timer >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/capdl-ok."* "$HOME/.config/systemd/user/capdl-bad."*
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

# --- environment: real systemd, user manager available --------------------
if ! systemctl --user show-environment >/dev/null 2>&1; then
    echo "SKIP: no systemd user manager in this environment" >&2
    exit 0
fi

# Harmless shutdown: records the call, never powers anything off.
cat > "$WORK/shutdown" <<'STUB'
#!/bin/bash
printf 'called %s args=%s\n' "$(date +%s)" "$*" >> "$SHUTDOWN_STUB_LOG"
exit 0
STUB
chmod +x "$WORK/shutdown"

mkdir -p "$HOME/.config/systemd/user" "$WORK/run"

# A runner that points the guard at isolated paths and the stub.
cat > "$WORK/run-guard" <<RUNNER
#!/bin/bash
export RUN_DIR="$WORK/run"
export DEADLINE_FILE="$WORK/run/deadline-epoch"
export STATUS_FILE="$WORK/run/deadline-status"
export SHUTDOWN_BIN="$WORK/shutdown"
export SHUTDOWN_STUB_LOG="$STUB_LOG"
# This harness asserts activation and shutdown WIRING; the bounded evidence
# window before the shutdown call is asserted statically, and a 90s sleep here
# would outrun the harness's bounded waits.
export EW_SECONDS=0
printf '%s\n' "\$(date +%s)" >> "$WORK/activations-\${UNIT_TAG}.log"
exec bash "$GUARD"
RUNNER
chmod +x "$WORK/run-guard"

make_units() {  # make_units <tag> <service-extra>
    local tag="$1" extra="$2"
    cat > "$HOME/.config/systemd/user/capdl-${tag}.service" <<UNIT
[Unit]
Description=deadline activation test (${tag})
[Service]
Type=oneshot
${extra}
Environment=UNIT_TAG=${tag}
ExecStart=$WORK/run-guard
UNIT
    cat > "$HOME/.config/systemd/user/capdl-${tag}.timer" <<UNIT
[Unit]
Description=deadline activation test timer (${tag})
[Timer]
OnBootSec=1s
OnUnitActiveSec=1s
AccuracySec=1ms
Unit=capdl-${tag}.service
[Install]
WantedBy=timers.target
UNIT
}

make_units ok ""
# The old, broken shape: stays active after the first run, so the timer can no
# longer start it.
make_units bad "RemainAfterExit=yes"

systemctl --user daemon-reload

fail=0
note() { printf '  %s\n' "$*"; }
bad_() { printf '  FAIL  %s\n' "$*"; fail=1; }

# --- 1. future deadline: the guard must run MANY times, never shut down ----
echo $(( $(date +%s) + 3600 )) > "$WORK/run/deadline-epoch"
: > "$STUB_LOG"
systemctl --user start capdl-ok.timer
sleep 7
systemctl --user stop capdl-ok.timer

ok_runs=$(wc -l < "$WORK/activations-ok.log" 2>/dev/null || echo 0)
ok_calls=$(wc -l < "$STUB_LOG" 2>/dev/null || echo 0)
note "fixed units: ${ok_runs} activation(s), ${ok_calls} shutdown call(s)"
if [ "$ok_runs" -ge 3 ]; then
    note "PASS  the guard was genuinely re-activated by the timer"
else
    bad_ "expected >= 3 activations before the deadline, saw ${ok_runs}"
fi
if [ "$ok_calls" -eq 0 ]; then
    note "PASS  no shutdown before the deadline"
else
    bad_ "shutdown was called before the deadline"
fi

# --- 2. the broken variant must activate only once ------------------------
: > "$WORK/activations-bad.log"
systemctl --user start capdl-bad.timer
sleep 5
systemctl --user stop capdl-bad.timer
bad_runs=$(wc -l < "$WORK/activations-bad.log" 2>/dev/null || echo 0)
note "RemainAfterExit=yes: ${bad_runs} activation(s)"
if [ "$bad_runs" -le 1 ]; then
    note "PASS  RemainAfterExit really does block re-activation (the defect is real)"
else
    bad_ "expected the broken variant to stop at 1 activation, saw ${bad_runs}"
fi

# --- 3. expired deadline: the NEXT activation must call shutdown ----------
echo $(( $(date +%s) - 5 )) > "$WORK/run/deadline-epoch"
: > "$STUB_LOG"
systemctl --user start capdl-ok.timer
for _ in $(seq 1 20); do
    [ -s "$STUB_LOG" ] && break
    sleep 1
done
systemctl --user stop capdl-ok.timer
if [ -s "$STUB_LOG" ]; then
    note "PASS  an expired deadline triggers the shutdown call: $(head -1 "$STUB_LOG")"
else
    bad_ "an expired deadline did not reach the shutdown path"
fi
note "status recorded: $(cat "$WORK/run/deadline-status" 2>/dev/null)"

# --- 4. malformed deadlines must fail closed -----------------------------
printf '17abc400' > "$WORK/run/deadline-epoch"
: > "$STUB_LOG"
RUN_DIR="$WORK/run" DEADLINE_FILE="$WORK/run/deadline-epoch" \
STATUS_FILE="$WORK/run/deadline-status" SHUTDOWN_BIN="$WORK/shutdown" \
SHUTDOWN_STUB_LOG="$STUB_LOG" EW_SECONDS=0 bash "$GUARD" >/dev/null 2>&1
if [ -s "$STUB_LOG" ]; then
    note "PASS  a non-numeric deadline fails closed rather than being coerced"
else
    bad_ "a malformed deadline was accepted"
fi

echo
if [ "$fail" -ne 0 ]; then
    echo "DEADLINE ACTIVATION FAILED"
    exit 1
fi
echo "DEADLINE ACTIVATION PASSED"
echo "NOTE: this proves repeated timer activation of the guard. It does not reboot"
echo "a host; survival across a real reboot is still unverified."

#!/usr/bin/env bash
#
# Prove the Stage 4 runner hold is bounded and correct, without AWS and without
# waiting: the AWS call is stubbed, and the windows are chosen so every case
# finishes in seconds.
#
# Cases:
#   a non-number HOLD_MINUTES is an error, never a silent skip
#   a huge HOLD_MINUTES is capped at 120 minutes
#   a guest deadline in the past ends the hold immediately
#   a terminated instance ends the hold immediately
#   a running instance with a zero-minute hold closes the window immediately
#
# Exit 0 when every case holds, 1 otherwise.
set -uo pipefail
REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
cd "$REPO" || exit 1

FAIL=0
ok()  { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }

run_hold() { # $1 = HOLD_MINUTES, $2 = deadline-epoch, $3 = aws stub behaviour
    local W
    W=$(mktemp -d)
    printf 'i-0123456789abcdef0' > "$W/instance-id"
    printf '%s' "$2" > "$W/deadline-epoch"
    mkdir -p "$W/bin"
    cat > "$W/bin/aws" <<STUB
#!/usr/bin/env bash
$3
STUB
    chmod +x "$W/bin/aws"
    set +e
    STATE_DIR="$W" HOLD_MINUTES="$1" CAP_PROFILE=stub CAP_REGION=stub-region \
        PATH="$W/bin:$PATH" bash infra/capacity-run/hold-runner.sh >"$W/out" 2>&1
    local rc=$?
    set -u
    local window out
    window=$(cat "$W/hold-window" 2>/dev/null || echo none)
    window=${window#hold-until-epoch=}
    out=$(cat "$W/out")
    rm -rf "$W"
    # Output contract: line 1 = exit code, line 2 = hold-window epoch,
    # line 3+ = the script's own console output.
    printf '%s\n%s\n%s\n' "$rc" "$window" "$out"
}

# a. Non-number: error, not a skip.
OUT=$(run_hold "forty-five" "0" "exit 1")
RC=$(printf '%s' "$OUT" | head -1)
if [ "$RC" = "1" ]; then ok "a non-number HOLD_MINUTES is an error, not a skip"
else bad "a non-number HOLD_MINUTES exited $RC, expected 1"; fi

# b. Cap: 999 minutes must never be held; the window is at most 120 minutes out.
#    The stub reports a terminated instance so the poll ends the hold at once;
#    what is under test here is the WINDOW, not the wait.
NOW=$(date +%s)
OUT=$(run_hold "999" "0" "echo terminated")
WINDOW=$(printf '%s' "$OUT" | sed -n 2p)
DIFF=$(( WINDOW - NOW ))
if [ "$DIFF" -le $(( 121 * 60 )) ] && [ "$DIFF" -ge $(( 119 * 60 )) ]; then
    ok "a huge HOLD_MINUTES is capped at 120 minutes (window +$(( DIFF / 60 ))min)"
else
    bad "the cap did not hold: window is +$(( DIFF / 60 ))min"
fi

# c. Guest deadline in the past: the hold must end immediately, and never run
#    past the deadline.
OUT=$(run_hold "45" "$(( NOW - 1000 ))" "echo terminated")
RC=$(printf '%s' "$OUT" | head -1)
WINDOW=$(printf '%s' "$OUT" | sed -n 2p)
if [ "$RC" = "0" ] && [ "$WINDOW" -lt "$NOW" ]; then
    ok "a past guest deadline ends the hold immediately (window clamped to deadline-300)"
else
    bad "past-deadline case: rc=$RC window=$WINDOW now=$NOW"
fi

# d. Terminated instance: the hold ends here, immediately.
OUT=$(run_hold "45" "0" "echo terminated")
RC=$(printf '%s' "$OUT" | head -1)
if [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -q 'the hold ends here'; then
    ok "a terminated instance ends the hold immediately"
else
    bad "terminated-instance case: rc=$RC"
fi

# e. Running instance, zero-minute hold: the loop never runs, the window closes.
OUT=$(run_hold "0" "0" "echo running")
RC=$(printf '%s' "$OUT" | head -1)
if [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -q 'hold window closed'; then
    ok "a zero-minute hold closes the window immediately"
else
    bad "zero-minute case: rc=$RC"
fi

printf '\n---- stage4-hold: %s ----\n' "$([ "$FAIL" -eq 0 ] && echo PASS || echo "FAIL ($FAIL)")"
[ "$FAIL" -eq 0 ] || exit 1

#!/usr/bin/env bash
#
# Prove the Stage 4 approval wait is bounded and fail-closed, without AWS,
# GitHub or waiting: the AWS call and the variables-API read are stubbed, and
# the windows are chosen so every case finishes in seconds.
#
# The contract under test:
#   a non-number HOLD_MINUTES is an error, never a silent skip
#   a huge HOLD_MINUTES is capped at 120 minutes
#   a guest deadline in the past ends the wait immediately
#   a terminated instance ends the wait as instance-gone
#   a zero-minute wait closes the window immediately as timeout
#   an ABSENT variable is never an approval
#   a MALFORMED value is never an approval
#   another run's id in the value is never an approval
#   another commit's sha in the value is never an approval
#   a re-run (attempt > 1) is never an approval, even with a matching value
#   the exact "<this run>:<this launch sha>" value IS the approval
#
# Exit 0 when every case holds, 1 otherwise.
set -uo pipefail
REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
cd "$REPO" || exit 1

FAIL=0
ok()  { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }

RUN_ID=43564821440
LAUNCH_SHA=0123456789abcdef0123456789abcdef01234567

# $1 = HOLD_MINUTES, $2 = deadline-epoch, $3 = aws stub behaviour,
# $4 = variables-API behaviour (the body curl prints, or "fail" to fail),
# $5 = RUN_ATTEMPT (default 1)
run_wait() {
    local W
    W=$(mktemp -d)
    printf 'i-0123456789abcdef0' > "$W/instance-id"
    printf '%s' "$2" > "$W/deadline-epoch"
    printf '%s' "$LAUNCH_SHA" > "$W/launch-sha"
    mkdir -p "$W/bin"
    cat > "$W/bin/aws" <<STUB
#!/usr/bin/env bash
$3
STUB
    chmod +x "$W/bin/aws"
    cat > "$W/bin/curl" <<STUB
#!/usr/bin/env bash
case "$4" in
    fail) exit 7 ;;
    *) printf '%s' '$4' ;;
esac
STUB
    chmod +x "$W/bin/curl"
    local attempt="${5:-1}"
    set +e
    STATE_DIR="$W" HOLD_MINUTES="$1" CAP_PROFILE=stub CAP_REGION=stub-region \
        GITHUB_TOKEN=stub-token RUN_ID="$RUN_ID" RUN_ATTEMPT="$attempt" \
        API_REPO=example/repo \
        PATH="$W/bin:$PATH" bash infra/capacity-run/hold-runner.sh >"$W/out" 2>&1
    local rc=$?
    set -u
    local window outcome
    window=$(cat "$W/hold-window" 2>/dev/null || echo none)
    window=${window#hold-until-epoch=}
    outcome=$(cat "$W/stage4-outcome" 2>/dev/null || echo none)
    rm -rf "$W"
    printf '%s\n%s\n%s\n' "$rc" "$window" "$outcome"
}

# a. Non-number: error, not a skip.
OUT=$(run_wait "forty-five" "0" "exit 1" "fail")
RC=$(printf '%s' "$OUT" | head -1)
if [ "$RC" = "1" ]; then ok "a non-number HOLD_MINUTES is an error, not a skip"
else bad "a non-number HOLD_MINUTES exited $RC, expected 1"; fi

# b. Cap: 999 minutes must never be held; the window is at most 120 minutes out.
#    The stub reports a terminated instance so the poll ends the wait at once;
#    what is under test here is the WINDOW, not the wait.
NOW=$(date +%s)
OUT=$(run_wait "999" "0" "echo terminated" "fail")
WINDOW=$(printf '%s' "$OUT" | sed -n 2p)
if [ "$WINDOW" != "none" ] && [ "$WINDOW" -le $((NOW + 120*60 + 5)) ]; then
    ok "a 999-minute request is capped at a 120-minute window"
else
    bad "the window for a 999-minute request is $WINDOW"
fi

# c. A deadline in the past ends the wait immediately.
OUT=$(run_wait "45" "1" "echo running" "fail")
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "timeout" ]; then ok "a deadline in the past closes the window at once"
else bad "a past deadline produced outcome '$OUTCOME'"; fi

# d. A terminated instance ends the wait as instance-gone - never as a timeout
#    that would trigger cleanup against a ghost.
OUT=$(run_wait "45" "0" "echo terminated" "fail")
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "instance-gone" ]; then ok "a terminated instance ends the wait as instance-gone"
else bad "a terminated instance produced outcome '$OUTCOME'"; fi

# e. A zero-minute wait closes immediately as timeout.
OUT=$(run_wait "0" "0" "echo running" "fail")
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "timeout" ]; then ok "a zero-minute wait closes immediately as timeout"
else bad "a zero-minute wait produced outcome '$OUTCOME'"; fi

# f. An absent variable (the API read fails) is never an approval.
OUT=$(run_wait "0" "0" "echo running" "fail")
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "timeout" ]; then ok "an unreadable variable is never an approval"
else bad "an unreadable variable produced outcome '$OUTCOME'"; fi

# g. A malformed value is never an approval.
OUT=$(run_wait "0" "0" "echo running" '{"value":"yes"}')
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "timeout" ]; then ok "a malformed value is never an approval"
else bad "a malformed value produced outcome '$OUTCOME'"; fi

# h. Another run's id is never an approval.
OUT=$(run_wait "0" "0" "echo running" "{\"value\":\"99999999999:$LAUNCH_SHA\"}")
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "timeout" ]; then ok "another run's id is never an approval"
else bad "a foreign run id produced outcome '$OUTCOME'"; fi

# i. Another commit's sha is never an approval.
OUT=$(run_wait "0" "0" "echo running" "{\"value\":\"$RUN_ID:ffffffffffffffffffffffffffffffffffffffff\"}")
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "timeout" ]; then ok "another commit's sha is never an approval"
else bad "a foreign sha produced outcome '$OUTCOME'"; fi

# j. A re-run (attempt > 1) is never an approval, even with a matching value.
OUT=$(run_wait "0" "0" "echo running" "{\"value\":\"$RUN_ID:$LAUNCH_SHA\"}" 2)
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "timeout" ]; then ok "a re-run (attempt > 1) is never an approval"
else bad "attempt 2 produced outcome '$OUTCOME'"; fi

# k. The exact "<this run>:<this launch sha>" value IS the approval.
OUT=$(run_wait "0" "0" "echo running" "{\"value\":\"$RUN_ID:$LAUNCH_SHA\"}" 1)
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "approved" ]; then ok "the exact run-id and launch-sha value is the approval"
else bad "the matching value produced outcome '$OUTCOME'"; fi

# l. A missing launch-sha in the state directory approves nothing even when the
#    variable names this run: the binding has nothing to compare against.
W=$(mktemp -d)
printf 'i-0123456789abcdef0' > "$W/instance-id"
printf '%s' "0" > "$W/deadline-epoch"
mkdir -p "$W/bin"
printf '#!/usr/bin/env bash\necho running\n' > "$W/bin/aws"
printf '#!/usr/bin/env bash\nprintf %s '"'"'{"value":"'"$RUN_ID"':'"$LAUNCH_SHA"'"}'"'"'\n' > "$W/bin/curl"
chmod +x "$W/bin/aws" "$W/bin/curl"
set +e
STATE_DIR="$W" HOLD_MINUTES=0 CAP_PROFILE=stub CAP_REGION=stub-region \
    GITHUB_TOKEN=stub-token RUN_ID="$RUN_ID" RUN_ATTEMPT=1 API_REPO=example/repo \
    PATH="$W/bin:$PATH" bash infra/capacity-run/hold-runner.sh >"$W/out" 2>&1
OUTCOME=$(cat "$W/stage4-outcome" 2>/dev/null || echo none)
set -u
rm -rf "$W"
if [ "$OUTCOME" = "timeout" ]; then ok "a missing launch-sha record approves nothing"
else bad "a missing launch-sha produced outcome '$OUTCOME'"; fi

if [ "$FAIL" -eq 0 ]; then
    printf 'ALL %s CASES PASS\n' 12
    exit 0
fi
printf '%s CASE(S) FAILED\n' "$FAIL"
exit 1

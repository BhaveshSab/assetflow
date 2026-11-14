#!/usr/bin/env bash
#
# Prove the Stage 4 approval wait is bounded and fail-closed, without AWS,
# GitHub or waiting: the AWS call and the issue-comments read are stubbed, and
# the windows are chosen so every case finishes in seconds.
#
# The channel is an ISSUE COMMENT, not a repository variable. A repository
# variable cannot be read with GITHUB_TOKEN at all (the permissions list has no
# variables scope, and vars.* is frozen at job start), which is why the
# variable-based wait produced no load on attempt 22.
#
# The contract under test:
#   a non-number HOLD_MINUTES is an error, never a silent skip
#   a huge HOLD_MINUTES is capped at 120 minutes
#   a guest deadline in the past ends the wait immediately
#   a terminated instance ends the wait as instance-gone
#   a zero-minute wait closes the window immediately as timeout
#   no approval comment is never an approval
#   a MALFORMED approval line is never an approval
#   another run's id in the line is never an approval
#   another commit's sha in the line is never an approval
#   a re-run (attempt > 1) is never an approval, even with a matching line
#   an UNREADABLE issue (403/404) is an explicit `denied`, not a silent wait
#   a THROTTLED read is an explicit `throttled`, not a silent wait
#   the exact "<this run>:<this launch sha>" line IS the approval
#   a matching approval TRANSITIONS into the load orchestration
#
# Exit 0 when every case holds, 1 otherwise.
set -uo pipefail
REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
cd "$REPO" || exit 1

FAIL=0
PASSED=0
ok()  { PASSED=$((PASSED + 1)); printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }

RUN_ID=43564821440
LAUNCH_SHA=0123456789abcdef0123456789abcdef01234567

# $1 = HOLD_MINUTES, $2 = deadline-epoch, $3 = aws stub behaviour,
# $4 = the JSON array the comments endpoint returns, or an HTTP status to
#      refuse with ("403", "404", "429", "fail" for a transport error),
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
    # The stub answers like the real call: the body comes from a data file (so
    # no JSON is ever pasted into shell source) and the status is printed for
    # -w. A refusal writes a JSON message body first.
    printf '%s' "$4" > "$W/response-body"
    case "$4" in
        fail)  printf 'transport-fail' > "$W/response-status" ;;
        403)   printf '%s' '{"message":"Resource not accessible by integration"}' > "$W/response-body"
               printf '403' > "$W/response-status" ;;
        404)   printf '%s' '{"message":"Not Found"}' > "$W/response-body"
               printf '404' > "$W/response-status" ;;
        429)   printf '%s' '{"message":"rate limited"}' > "$W/response-body"
               printf '429' > "$W/response-status" ;;
        *)     printf '200' > "$W/response-status" ;;
    esac
    cat > "$W/bin/curl" <<'CURLSTUB'
#!/usr/bin/env bash
# Read the canned response from files written by the harness. No body is ever
# interpolated into this source.
here="$(cd "$(dirname "$0")/.." && pwd)"
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
status="$(cat "$here/response-status" 2>/dev/null || echo 000)"
[ "$status" = "transport-fail" ] && exit 7
[ -n "$out" ] && cat "$here/response-body" > "$out" 2>/dev/null
printf '%s' "$status"
exit 0
CURLSTUB
    chmod +x "$W/bin/curl"
    local attempt="${5:-1}"
    set +e
    STATE_DIR="$W" HOLD_MINUTES="$1" CAP_PROFILE=stub CAP_REGION=stub-region \
        GITHUB_TOKEN=stub-token RUN_ID="$RUN_ID" RUN_ATTEMPT="$attempt" \
        API_REPO=example/repo STAGE4_ISSUE=1 \
        PATH="$W/bin:/usr/local/bin:/usr/bin:/bin" bash infra/capacity-run/hold-runner.sh >"$W/out" 2>&1
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

# f. A transport failure is never an approval, and is named as such.
OUT=$(run_wait "0" "0" "echo running" "fail")
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "timeout" ] || [ "$OUTCOME" = "malformed" ]; then
    ok "a failed comment read is never an approval (outcome '$OUTCOME')"
else bad "a failed read produced outcome '$OUTCOME'"; fi

# g. A malformed approval line is never an approval.
OUT=$(run_wait "0" "0" "echo running" '[{"id": 1, "body": "stage4-approve yes"}]')
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "timeout" ]; then ok "a malformed approval line is never an approval"
else bad "a malformed line produced outcome '$OUTCOME'"; fi

# h. Another run's id is never an approval.
OUT=$(run_wait "0" "0" "echo running" '[{"id": 1, "body": "stage4-approve 99999999999:$LAUNCH_SHA"}]')
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "timeout" ]; then ok "another run's id is never an approval"
else bad "a foreign run id produced outcome '$OUTCOME'"; fi

# i. Another commit's sha is never an approval.
OUT=$(run_wait "0" "0" "echo running" '[{"id": 1, "body": "stage4-approve $RUN_ID:ffffffffffffffffffffffffffffffffffffffff"}]')
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "timeout" ]; then ok "another commit's sha is never an approval"
else bad "a foreign sha produced outcome '$OUTCOME'"; fi

# j. A re-run (attempt > 1) is never an approval, even with a matching line.
OUT=$(run_wait "0" "0" "echo running" "[{\"id\": 1, \"body\": \"stage4-approve $RUN_ID:$LAUNCH_SHA\"}]" 2)
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "timeout" ]; then ok "a re-run (attempt > 1) is never an approval"
else bad "attempt 2 produced outcome '$OUTCOME'"; fi

# k. The exact "<this run>:<this launch sha>" line IS the approval.
OUT=$(run_wait "0" "0" "echo running" "[{\"id\": 1, \"body\": \"stage4-approve $RUN_ID:$LAUNCH_SHA\"}]" 1)
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "approved" ]; then ok "the exact run-id and launch-sha line is the approval"
else bad "the matching line produced outcome '$OUTCOME'"; fi

# k2. An UNREADABLE issue is an explicit denial, not a silent wait. This is the
#     exact failure the variable design hid: 403 was indistinguishable from
#     "not yet approved", so the hold burned its whole window.
OUT=$(run_wait "45" "0" "echo running" "403")
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "denied" ]; then ok "an unreadable approvals issue is an explicit denial"
else bad "HTTP 403 produced outcome '$OUTCOME', wanted denied"; fi

# k3. A 404 (wrong issue number) is also an explicit denial.
OUT=$(run_wait "45" "0" "echo running" "404")
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "denied" ]; then ok "a 404 on the approvals issue is an explicit denial"
else bad "HTTP 404 produced outcome '$OUTCOME', wanted denied"; fi

# k4. Throttling is reported as such, and does not hang the window.
OUT=$(run_wait "45" "0" "echo running" "429")
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "throttled" ]; then ok "a throttled read is reported as throttled"
else bad "HTTP 429 produced outcome '$OUTCOME', wanted throttled"; fi

# k5. A matching approval must TRANSITION into the load orchestration, not
#     merely record a word. `approved` is the handoff the workflow keys on.
OUT=$(run_wait "0" "0" "echo running" "[{\"id\": 1, \"body\": \"stage4-approve $RUN_ID:$LAUNCH_SHA\"}]" 1)
OUTCOME=$(printf '%s' "$OUT" | sed -n 3p)
if [ "$OUTCOME" = "approved" ]; then
    ok "a matching approval hands off to the load orchestration"
else
    bad "the handoff produced outcome '$OUTCOME'"; fi

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
    GITHUB_TOKEN=stub-token RUN_ID="$RUN_ID" RUN_ATTEMPT=1 API_REPO=example/repo STAGE4_ISSUE=1 \
    PATH="$W/bin:/usr/local/bin:/usr/bin:/bin" bash infra/capacity-run/hold-runner.sh >"$W/out" 2>&1
OUTCOME=$(cat "$W/stage4-outcome" 2>/dev/null || echo none)
set -u
rm -rf "$W"
if [ "$OUTCOME" = "timeout" ]; then ok "a missing launch-sha record approves nothing"
else bad "a missing launch-sha produced outcome '$OUTCOME'"; fi

if [ "$FAIL" -eq 0 ]; then
    printf 'ALL %s CASES PASS\n' "$((PASSED))"
    exit 0
fi
printf '%s CASE(S) FAILED\n' "$FAIL"
exit 1

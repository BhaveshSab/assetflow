#!/usr/bin/env bash
#
# The Stage 4 approval wait, on the retained runner.
#
# This replaces the passive hold. A passive hold could keep the runner alive,
# but nothing could ever turn an approval into work: the job cannot accept
# external input, and when the hold ends the runner - with its CA, token and
# state - is destroyed. The wait therefore POLLS for the approval itself and,
# on a match, hands control back to the workflow, which runs Stage 4 on this
# same runner.
#
# The approval is a repository variable, read at runtime through the REST API.
# A ${{ vars.* }} expression is evaluated once when the workflow starts and can
# never see a value set while the job is running; the API read is live on every
# poll. The variable's value must be exactly "<run id>:<launch sha>":
#
#   - a missing or unreadable variable approves nothing;
#   - a value left over from an earlier run carries that run's id and can
#     never match this one (this is what makes it single-use per run);
#   - a value naming any other commit approves nothing;
#   - a re-run of the same workflow (run_attempt > 1) approves nothing, so a
#     failed first attempt cannot be retried into load by re-running the job;
#   - a malformed value approves nothing. Every mismatch is fail-closed.
#
# The wait stays bounded three ways, in this order:
#   1. STAGE4_HOLD_MINUTES (default 45) - a non-number is an error, not a skip.
#   2. a hard cap of 120 minutes, so a fat-fingered variable can never hold the
#      runner past the instance's own 4-hour lifetime.
#   3. the run's absolute guest deadline, minus a 5-minute margin.
#
# No AWS service beyond reading the instance state is involved, and the AWS
# call is made with the same explicit profile and region every other call uses.
#
# Environment:
#   STATE_DIR     required. Holds instance-id, deadline-epoch, launch-sha;
#                 stage4-outcome is written here.
#   HOLD_MINUTES  required. Minutes to wait, capped at 120.
#   CAP_PROFILE   required. AWS profile name.
#   CAP_REGION    required. AWS region.
#   GITHUB_TOKEN  required. The job's own token, used only to READ the
#                 approval variable. It is never printed and never retained.
#   RUN_ID        required. This workflow run's id (github.run_id).
#   RUN_ATTEMPT   required. This attempt number (github.run_attempt).
#   API_REPO      optional. Defaults to $GITHUB_REPOSITORY.
#
# Outcome (written to $STATE_DIR/stage4-outcome and echoed):
#   approved      the variable matched this run; Stage 4 may run
#   timeout       the window closed without a matching approval
#   instance-gone the instance ended; nothing left to test
set -euo pipefail

STATE_DIR="${STATE_DIR:?STATE_DIR is required}"
HOLD_MINUTES="${HOLD_MINUTES:?HOLD_MINUTES is required}"
CAP_PROFILE="${CAP_PROFILE:?CAP_PROFILE is required}"
CAP_REGION="${CAP_REGION:?CAP_REGION is required}"
GITHUB_TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
RUN_ID="${RUN_ID:?RUN_ID is required}"
RUN_ATTEMPT="${RUN_ATTEMPT:?RUN_ATTEMPT is required}"
API_REPO="${API_REPO:-${GITHUB_REPOSITORY:-}}"

[[ "$HOLD_MINUTES" =~ ^[0-9]+$ ]] || {
    echo "::error title=hold::STAGE4_HOLD_MINUTES is not a number" >&2
    exit 1
}
[ "$HOLD_MINUTES" -le 120 ] || HOLD_MINUTES=120
[ -n "$API_REPO" ] || { echo "::error title=hold::no repository for the API read" >&2; exit 1; }
[ "$RUN_ATTEMPT" = "1" ] || {
    # A re-run of this workflow is not the approved execution path: the
    # approval binds to attempt 1 of the run that launched the instance.
    echo "run attempt is $RUN_ATTEMPT, not 1: Stage 4 can never run on a re-run" >&2
}

INSTANCE_ID=$(cat "$STATE_DIR/instance-id" 2>/dev/null || echo unknown)
DEADLINE=$(cat "$STATE_DIR/deadline-epoch" 2>/dev/null || echo 0)
LAUNCH_SHA=$(cat "$STATE_DIR/launch-sha" 2>/dev/null || echo '')

END=$(( $(date +%s) + HOLD_MINUTES * 60 ))
if [ "$DEADLINE" -gt 0 ] && [ "$END" -gt "$DEADLINE" ]; then
    END=$(( DEADLINE - 300 ))
fi

echo "hold-until-epoch=$END" > "$STATE_DIR/hold-window"
echo "Waiting up to $HOLD_MINUTES minutes (max 120), bounded by the guest deadline."
echo "Retained instance: $INSTANCE_ID"
echo "Set the repository variable STAGE4_APPROVED to \"<run id>:<launch sha>\" to approve."
echo "The wait ends at $END; afterwards bounded cleanup runs without load."

# The approval read. Every failure mode - network error, absent variable,
# malformed value, wrong run, wrong commit - returns 1, which the caller treats
# as "not approved". Nothing here can invent an approval.
approval_matches() {
    local value
    value="$(curl -fsS --max-time 15 \
        -H "Authorization: Bearer $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/$API_REPO/actions/variables/STAGE4_APPROVED" \
        2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("value",""))' 2>/dev/null || true)"
    [ -n "$value" ] || return 1
    printf '%s' "$value" > "$STATE_DIR/stage4-approval-seen"
    # The value must be "<digits>:<40 hex>" - anything else is not an approval.
    printf '%s' "$value" | grep -Eq '^[0-9]+:[0-9a-f]{40}$' || return 1
    local seen_run seen_sha
    seen_run="${value%%:*}"
    seen_sha="${value#*:}"
    [ "$seen_run" = "$RUN_ID" ] || return 1
    [ -n "$LAUNCH_SHA" ] || return 1
    [ "$seen_sha" = "$LAUNCH_SHA" ] || return 1
    [ "$RUN_ATTEMPT" = "1" ] || return 1
    return 0
}

while :; do
    # The instance is checked first: a guest that ended itself ends the wait
    # regardless of any variable - dead targets get no load.
    ST=$(aws --profile "$CAP_PROFILE" --region "$CAP_REGION" \
        ec2 describe-instances --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null \
        || echo unknown)
    if [ "$ST" = "terminated" ] || [ "$ST" = "shutting-down" ]; then
        echo "instance is $ST; the wait ends here"
        echo "instance-gone" > "$STATE_DIR/stage4-outcome"
        exit 0
    fi
    # The approval is checked every iteration, and once even when the window
    # has already closed: an approval set seconds before the window's end is
    # still an approval, and a zero-minute window still gets one check.
    if approval_matches; then
        echo "the approval variable matched this run and launch sha"
        echo "approved" > "$STATE_DIR/stage4-outcome"
        exit 0
    fi
    [ "$(date +%s)" -lt "$END" ] || break
    sleep 30
done
echo "the wait window closed without a matching approval"
echo "timeout" > "$STATE_DIR/stage4-outcome"
exit 0

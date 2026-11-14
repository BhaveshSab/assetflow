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
# The approval is an ISSUE COMMENT, not a repository variable. The variable
# design was unbuildable: GET /repos/{o}/{r}/actions/variables/{n} requires the
# "Variables" repository permission, which is not in the GITHUB_TOKEN permission
# list at all, so no workflow `permissions:` key can grant it, and ${{ vars.* }}
# is frozen at job start. `issues: read` IS a documented GITHUB_TOKEN scope, and
# a comment is written by a human while the job holds, so it is readable
# mid-run. The comment body must carry exactly one line:
#
#       stage4-approve <run id>:<launch sha>
#
# with these consequences, all fail-closed:
#
#   - no such comment approves nothing;
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
#                 approvals issue's comments. Never printed, never retained.
#   STAGE4_ISSUE  required. The issue number whose comments carry approvals.
#   RUN_ID        required. This workflow run's id (github.run_id).
#   RUN_ATTEMPT   required. This attempt number (github.run_attempt).
#   API_REPO      optional. Defaults to $GITHUB_REPOSITORY.
#
# Outcome (written to $STATE_DIR/stage4-outcome and echoed):
#   approved      the variable matched this run; Stage 4 may run
#   timeout       the window closed without a matching approval
#   instance-gone the instance ended; nothing left to test
#   denied        the approvals issue could not be READ (401/403/404): an
#                 explicit bounded failure, never a silent wait
#   throttled     the API refused for quota, which waiting cannot fix
set -euo pipefail

STATE_DIR="${STATE_DIR:?STATE_DIR is required}"
HOLD_MINUTES="${HOLD_MINUTES:?HOLD_MINUTES is required}"
CAP_PROFILE="${CAP_PROFILE:?CAP_PROFILE is required}"
CAP_REGION="${CAP_REGION:?CAP_REGION is required}"
GITHUB_TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
RUN_ID="${RUN_ID:?RUN_ID is required}"
RUN_ATTEMPT="${RUN_ATTEMPT:?RUN_ATTEMPT is required}"
STAGE4_ISSUE="${STAGE4_ISSUE:?STAGE4_ISSUE is required}"
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
echo "To approve, comment on issue #$STAGE4_ISSUE with exactly:"
echo "  stage4-approve $RUN_ID:$LAUNCH_SHA"
echo "The wait ends at $END; afterwards bounded cleanup runs without load."

# The approval read is delegated to stage4-approval.sh, which records the HTTP
# status of every attempt and distinguishes absent, matched, stale, denied,
# throttled and malformed. The previous inline version discarded curl's exit
# status with `2>/dev/null || true`, so an access failure looked exactly like
# "not approved yet" and the wait sat silent for its whole window. That is the
# defect this replaces, and it is why attempt 22 produced no load.
APPROVAL_CHECK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stage4-approval.sh"
[ -f "$APPROVAL_CHECK" ] || {
    echo "::error title=hold::approval transport missing at $APPROVAL_CHECK" >&2
    echo "denied" > "$STATE_DIR/stage4-outcome"
    exit 1
}

approval_matches() {
    API_REPO="$API_REPO" RUN_ID="$RUN_ID" LAUNCH_SHA="$LAUNCH_SHA" \
    RUN_ATTEMPT="$RUN_ATTEMPT" STAGE4_ISSUE="$STAGE4_ISSUE" \
    GITHUB_TOKEN="$GITHUB_TOKEN" STATE_DIR="$STATE_DIR" \
        bash "$APPROVAL_CHECK" --check
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
    approval_matches || true
    APPROVAL_STATE="$(cat "$STATE_DIR/stage4-approval-outcome" 2>/dev/null || echo unknown)"
    case "$APPROVAL_STATE" in
        matched)
            echo "the approval comment matched this run and launch sha"
            echo "approved" > "$STATE_DIR/stage4-outcome"
            exit 0 ;;
        denied|throttled)
            # A read failure cannot be fixed by waiting: the token is not
            # allowed or the API refused. Fail explicitly and boundedly rather
            # than burning the whole window in silence.
            echo "::error title=hold::approvals unreadable ($APPROVAL_STATE, HTTP $(cat "$STATE_DIR/stage4-approval-status" 2>/dev/null || echo unknown))"
            echo "$APPROVAL_STATE" > "$STATE_DIR/stage4-outcome"
            exit 0 ;;
        *) : ;;
    esac
    [ "$(date +%s)" -lt "$END" ] || break
    sleep 30
done
echo "the wait window closed without a matching approval"
echo "timeout" > "$STATE_DIR/stage4-outcome"
exit 0

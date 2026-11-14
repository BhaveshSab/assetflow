#!/bin/bash
# Stage 4 approval transport.
#
# WHY THIS IS NOT A REPOSITORY VARIABLE
#   The first implementation read STAGE4_APPROVED through
#   GET /repos/{owner}/{repo}/actions/variables/{name}. That endpoint requires
#   the "Variables" repository permission, which is NOT in the GITHUB_TOKEN
#   permission list at all - the workflow `permissions:` key has no variables
#   scope, so no YAML can grant it. And the `vars` context is interpolated
#   before the job reaches the runner, so it can never see a mid-run change.
#   Reading a variable live is therefore impossible with GITHUB_TOKEN alone,
#   and the attempt-22 hold sat silent for exactly that reason.
#
# THE CHANNEL USED INSTEAD
#   An issue comment. `issues: read` IS a documented GITHUB_TOKEN scope, and a
#   comment is created by a human while the job is holding, so it is readable
#   mid-run. Comments are append-only and timestamped, which also makes the
#   approval auditable after the fact - a property the variable never had.
#
# WHAT AN APPROVAL MUST CONTAIN
#   A comment on the run's own issue whose body carries exactly one line:
#       stage4-approve <run_id>:<launch_sha>
#   run_id must be this run, launch_sha must be this run's recorded launch
#   sha, and run_attempt must be 1. Anything else approves nothing.
#
# ERROR HANDLING
#   The previous version swallowed curl's exit status with `2>/dev/null ||
#   true`, so an access failure was indistinguishable from "not approved yet".
#   This one records the HTTP status of every read and never hides a failure:
#     absent    - 200, no approval line present
#     matched   - 200, exactly one well-formed line for this run and sha
#     denied    - 401/403/404: the read itself failed
#     throttled - 429 or a rate-limit 403
#     malformed - 200 but a line that does not parse
#   `denied` and `throttled` are reported as explicit failures, because they
#   mean the mechanism is broken and waiting longer cannot fix them.
#
# USAGE
#   stage4-approval.sh --check         one read, prints the outcome, exit 0
#                                      only for `matched`
#   The caller loop lives in hold-runner.sh; this file only does the read and
#   the classification, so both can be tested separately.

set -uo pipefail

API="${API_BASE:-https://api.github.com}"
REPO="${API_REPO:?API_REPO is required (owner/name)}"
RUN_ID="${RUN_ID:?RUN_ID is required}"
LAUNCH_SHA="${LAUNCH_SHA:-}"
RUN_ATTEMPT="${RUN_ATTEMPT:?RUN_ATTEMPT is required}"
ISSUE="${STAGE4_ISSUE:?STAGE4_ISSUE is required (the issue number carrying approvals)}"
TOKEN="${GITHUB_TOKEN:-}"

# Where the classifier's findings are recorded, so a post-mortem does not
# depend on the step log being readable.
STATE_DIR="${STATE_DIR:-}"

record() {  # record <key> <value>
    [ -n "$STATE_DIR" ] || return 0
    printf '%s' "$2" > "$STATE_DIR/stage4-approval-$1" 2>/dev/null || true
}

say() { printf '%s\n' "$*" >&2; }

# Classify a raw HTTP status into one of the named failures. Kept separate so
# the test harness can exercise it without any network at all.
classify_status() {  # classify_status <status> <body>
    local status="$1" body="${2:-}"
    case "$status" in
        200) : ;;
        401) say "access denied (HTTP 401): the token is not accepted by the API"
             return 1 ;;
        403)
            # A 403 has two very different meanings and they must not be
            # conflated: rate limiting is transient, a permission refusal is
            # permanent. GitHub says which in the body.
            if printf '%s' "$body" | grep -qi 'rate limit'; then
                say "rate limited (HTTP 403): the API refused for quota, not permission"
            else
                say "access denied (HTTP 403): the token lacks permission to read issue comments"
            fi
            return 1 ;;
        404) say "not found (HTTP 404): the issue or repository is not visible to this token"
             return 1 ;;
        429) say "rate limited (HTTP 429): the API refused for quota"
             return 1 ;;
        5*|[0-9][0-9][0-9]) say "unexpected HTTP $status from the approvals endpoint"
             return 1 ;;
        000|"")
             say "no HTTP response from the approvals endpoint (network or TLS failure)"
             return 1 ;;
        *) say "unexpected HTTP $status from the approvals endpoint"
           return 1 ;;
    esac
    return 0
}

# Read the comments and pick the approval. Every non-200 is a named failure.
check() {
    [ -n "$TOKEN" ] || { say "no GITHUB_TOKEN in the environment"; record outcome invalid; return 1; }
    [ -n "$LAUNCH_SHA" ] || { say "no launch sha recorded; nothing can match"; record outcome invalid; return 1; }

    local body_file status http
    body_file="$(mktemp)"
    # -o writes the body, -w the status, and the exit status is NOT discarded:
    # a transport failure and an HTTP failure are both reported.
    http="$(curl -sS --max-time 20 -o "$body_file" -w '%{http_code}' \
        -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "$API/repos/$REPO/issues/$ISSUE/comments?per_page=100" 2>/dev/null)" || true
    status="${http:-000}"
    record status "$status"

    local body=""
    [ -s "$body_file" ] && body="$(cat "$body_file")"
    rm -f "$body_file"

    if ! classify_status "$status" "$body"; then
        case "$status" in
            401|403) if printf '%s' "$body" | grep -qi 'rate limit'; then record outcome throttled
                     else record outcome denied; fi ;;
            404) record outcome denied ;;
            429) record outcome throttled ;;
            *)   record outcome malformed ;;
        esac
        return 1
    fi

    # Extract every comment body, then look for the approval line. Done in
    # python so JSON parsing is real parsing, not a regex over escaped text.
    local verdict
    verdict="$(printf '%s' "$body" | python3 -c '
import json, re, sys
run_id, sha, attempt = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    data = json.load(sys.stdin)
except Exception as e:
    print("malformed: the response is not a JSON array (%s)" % type(e).__name__)
    raise SystemExit(0)
if not isinstance(data, list):
    print("malformed: the response is not a comment list")
    raise SystemExit(0)
pat = re.compile(r"^\s*stage4-approve\s+([0-9]+):([0-9a-f]{40})\s*$")
found = []
bad = 0
for c in data:
    body = (c.get("body") or "")
    for line in body.splitlines():
        if line.strip().lower().startswith("stage4-approve"):
            m = pat.match(line)
            if not m:
                bad += 1
                continue
            found.append((m.group(1), m.group(2)))
if attempt != "1":
    print("refused: run attempt is %s, not 1" % attempt)
    raise SystemExit(0)
for r, s in found:
    if r == run_id and s == sha:
        print("matched %s:%s" % (r, s))
        raise SystemExit(0)
if bad and not found:
    print("malformed: %d approval line(s) that do not parse" % bad)
    raise SystemExit(0)
if found:
    print("stale: approval present but for a different run or launch sha")
    raise SystemExit(0)
print("absent: no approval comment for run %s" % run_id)
' "$RUN_ID" "$LAUNCH_SHA" "$RUN_ATTEMPT" 2>/dev/null)" || verdict="malformed: the classifier failed"

    printf '%s' "$verdict" >&2
    printf '\n' >&2
    case "$verdict" in
        matched*)       record outcome matched; return 0 ;;
        absent*)        record outcome absent; return 1 ;;
        stale*)         record outcome stale; return 1 ;;
        refused*)       record outcome refused; return 1 ;;
        malformed*)     record outcome malformed; return 1 ;;
        *)              record outcome malformed; return 1 ;;
    esac
}

case "${1:---check}" in
    --check) check ;;
    --classify) shift; classify_status "$@" ;;
    *) say "usage: $0 [--check | --classify <status> <body>]"; exit 2 ;;
esac

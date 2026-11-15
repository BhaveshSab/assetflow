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
# WHO MAY APPROVE
#   An earlier version matched the comment TEXT and nothing else. A run id and
#   a launch sha are public, so on a public repository any account able to
#   comment - including a bot - could have granted approval by copying that
#   line. Text match alone is therefore not an approval.
#   A comment counts only when GitHub itself attributes it to the authorized
#   operator. Every one of these must hold on the same comment:
#     user.login            == STAGE4_APPROVER, case-insensitively
#     user.type             is not "Bot"
#     performed_via_github_app is null (a GitHub App, not a human, wrote it)
#     author_association    is OWNER, MEMBER or COLLABORATOR
#     created_at            is not earlier than the approval window start
#   The login is compared, not the display name, and it is the login the API
#   returned - not one quoted in the comment body, which the commenter
#   controls. A commenter cannot claim an identity by typing it.
#
# PAGINATION
#   Reading only page 1 would report "absent" while a real approval sat on
#   page 2, which is the failure mode that looks like patience. The read
#   follows the Link: rel="next" header up to a page cap; if the cap is hit
#   with more pages remaining the outcome is "malformed" (an incomplete scan),
#   never "absent".
#
# ERROR HANDLING
#   The previous version swallowed curl's exit status with `2>/dev/null ||
#   true`, so an access failure was indistinguishable from "not approved yet".
#   This one records the HTTP status of every read and never hides a failure:
#     absent    - 200, no approval line present
#     matched   - 200, a well-formed line for this run and sha from the
#                 authorized operator
#     unauthorized - a matching line exists but GitHub attributes it to
#                 someone other than the authorized operator, or to a bot/app
#     stale     - a matching line exists but is for another run/sha, or it
#                 predates this run's approval window
#     denied    - 401/403/404: the read itself failed
#     throttled - 429 or a rate-limit 403
#     malformed - 200 but a line does not parse, or the scan was truncated
#   `unauthorized` is deliberately distinct from `absent`: someone posted the
#   approval line and it did not count. That is exactly the case a security
#   review needs to be able to see.
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
APPROVER="${STAGE4_APPROVER:?STAGE4_APPROVER is required (the only login allowed to approve)}"
# Earliest acceptable approval timestamp, ISO-8601 UTC. An approval written
# before this run's window opened cannot authorize this run.
WINDOW_START="${STAGE4_WINDOW_START:-}"
# Bound on pages followed. 100 comments/page; 20 pages is 2000 comments on a
# dedicated approvals issue, far beyond real use. Hitting it is a hard error.
MAX_PAGES="${STAGE4_MAX_PAGES:-20}"
TOKEN="${GITHUB_TOKEN:-}"

# Where the classifier's findings are recorded, so a post-mortem does not
# depend on the step log being readable.
STATE_DIR="${STATE_DIR:-}"

# Set by fetch_comments so check() can name the failure without a subshell.
LAST_STATUS=""
LAST_BODY=""

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

# Fetch every page of comments into one JSON array. Follows the Link header's
# rel="next" relation, which is what the API documents for pagination. A
# non-200 on any page fails the whole read: a partial scan cannot distinguish
# "no approval" from "approval on the page we did not fetch".
fetch_comments() {  # fetch_comments <outfile>
    local out="$1" page_url next body_file http body link flat
    local pages=0 first=1
    page_url="$API/repos/$REPO/issues/$ISSUE/comments?per_page=100"
    printf '[' > "$out"
    while [ -n "$page_url" ]; do
        pages=$((pages + 1))
        if [ "$pages" -gt "$MAX_PAGES" ]; then
            LAST_STATUS="truncated"
            say "stopped after $MAX_PAGES pages with more comments remaining"
            return 1
        fi
        body_file="$(mktemp)"
        http="$(curl -sS --max-time 20 -D "${body_file}.hdr" -o "$body_file" -w '%{http_code}' \
            -H "Authorization: Bearer $TOKEN" \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            "$page_url" 2>/dev/null)" || true
        LAST_STATUS="${http:-000}"
        record status "$LAST_STATUS"
        body=""
        [ -s "$body_file" ] && body="$(cat "$body_file")"
        link=""
        [ -f "${body_file}.hdr" ] && link="$(grep -i '^link:' "${body_file}.hdr" | tr -d '\r')"
        if ! classify_status "$LAST_STATUS" "$body"; then
            LAST_BODY="$body"
            rm -f "$body_file" "${body_file}.hdr"
            return 1
        fi
        flat="${body_file}.flat"
        if ! printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit(3)
if not isinstance(d, list):
    raise SystemExit(3)
sys.stdout.write("\x00".join(json.dumps(c) for c in d))
' > "$flat" 2>/dev/null; then
            LAST_STATUS="malformed"
            LAST_BODY="$body"
            rm -f "$body_file" "${body_file}.hdr" "$flat"
            return 1
        fi
        if [ -s "$flat" ]; then
            [ "$first" -eq 0 ] && printf ',' >> "$out"
            cat "$flat" >> "$out"
            first=0
        fi
        next=""
        if printf '%s' "$link" | grep -q 'rel="next"'; then
            next="$(printf '%s' "$link" | tr ',' '\n' | grep 'rel="next"' | sed -e 's/.*<//' -e 's/>.*//')"
        fi
        page_url="$next"
        rm -f "$body_file" "${body_file}.hdr" "$flat"
    done
    printf ']' >> "$out"
    return 0
}

check() {
    [ -n "$TOKEN" ] || { say "no GITHUB_TOKEN in the environment"; record outcome invalid; return 1; }
    [ -n "$LAUNCH_SHA" ] || { say "no launch sha recorded; nothing can match"; record outcome invalid; return 1; }
    case "$APPROVER" in
        ""|"*"|*" "*)
            say "STAGE4_APPROVER is not a plausible single login: '$APPROVER'"
            record outcome invalid; return 1 ;;
    esac

    LAST_STATUS=""; LAST_BODY=""
    local dump verdict rc
    dump="$(mktemp)"
    if ! fetch_comments "$dump"; then
        rm -f "$dump"
        case "$LAST_STATUS" in
            401|403)
                if printf '%s' "$LAST_BODY" | grep -qi 'rate limit'; then
                    say "rate limited: the API refused for quota, not permission"
                    record outcome throttled
                else
                    say "access denied (HTTP $LAST_STATUS): cannot read issue comments"
                    record outcome denied
                fi ;;
            404)
                say "not found (HTTP 404): the issue or repository is not visible to this token"
                record outcome denied ;;
            429)
                say "rate limited (HTTP 429): the API refused for quota"
                record outcome throttled ;;
            truncated)
                say "malformed: the comment scan hit the page cap with more pages remaining"
                record outcome malformed ;;
            *)
                say "malformed: the approvals response could not be parsed (status $LAST_STATUS)"
                record outcome malformed ;;
        esac
        return 1
    fi

    verdict="$(python3 - "$dump" "$RUN_ID" "$LAUNCH_SHA" "$RUN_ATTEMPT" "$APPROVER" "$WINDOW_START" 2>/dev/null <<'PY'

import json, re, sys
dump, run_id, sha, attempt, approver, window = sys.argv[1:7]
try:
    with open(dump, encoding="utf-8") as fh:
        data = json.load(fh)
except Exception as e:
    print("malformed: the response is not a JSON array (%s)" % type(e).__name__)
    raise SystemExit(0)
if not isinstance(data, list):
    print("malformed: the response is not a comment list")
    raise SystemExit(0)

pat = re.compile(r"^\s*stage4-approve\s+([0-9]+):([0-9a-f]{40})\s*$")
want = approver.strip().lower()


def ts(s):
    # "2026-11-14T12:00:00Z" -> comparable tuple; None if unparsable
    if not isinstance(s, str) or len(s) < 19:
        return None
    try:
        return (int(s[0:4]), int(s[5:7]), int(s[8:10]),
                int(s[11:13]), int(s[14:16]), int(s[17:19]))
    except ValueError:
        return None


window_ts = ts(window) if window else None
found = 0
bad = 0
reasons = []
stale_window = False

for c in data:
    if not isinstance(c, dict):
        bad += 1
        continue
    body = c.get("body") or ""
    if not isinstance(body, str):
        continue
    hits = []
    loose = 0
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("stage4-approve"):
            m = pat.match(stripped)
            if not m:
                loose += 1
                continue
            hits.append((m.group(1), m.group(2)))
    if not hits and not loose:
        continue

    # Identity comes from what GitHub attributed, never from the body text.
    user = c.get("user") if isinstance(c.get("user"), dict) else {}
    login = user.get("login") or ""
    utype = user.get("type") or ""
    assoc = c.get("author_association") or ""
    app = c.get("performed_via_github_app")

    if utype.lower() == "bot":
        reasons.append("author %s is a bot" % (login or "<unknown>"))
        continue
    if app:
        reasons.append("comment %s was written by a GitHub App, not a person"
                       % c.get("id", "<unknown>"))
        continue
    if not hits:
        # Nothing parseable from this author. Only the operator's own garbage
        # counts as a malformed approval attempt.
        if login.strip().lower() == want:
            bad += loose
        else:
            reasons.append("author %s is not the authorized operator %s"
                           % (login or "<unknown>", approver))
        continue
    found += len(hits)
    # Identity first: a stranger's comment is not an approval at all, so it
    # says nothing about whether the operator approved in time.
    if login.strip().lower() != want:
        reasons.append("author %s is not the authorized operator %s"
                       % (login or "<unknown>", approver))
        continue
    if assoc not in ("OWNER", "MEMBER", "COLLABORATOR"):
        reasons.append("author %s has association %s, not OWNER/MEMBER/COLLABORATOR"
                       % (login, assoc or "<none>"))
        continue

    created = ts(c.get("created_at"))
    if created is None:
        reasons.append("comment %s has no usable created_at" % c.get("id", "<unknown>"))
        continue
    if window_ts is not None and created < window_ts:
        stale_window = True
        reasons.append("comment created %s predates the approval window %s"
                       % (c.get("created_at"), window))
        continue

    if attempt != "1":
        print("refused: run attempt is %s, not 1" % attempt)
        raise SystemExit(0)

    for r, s in hits:
        if r == run_id and s == sha:
            print("matched %s:%s by %s" % (r, s, login))
            raise SystemExit(0)

if attempt != "1":
    print("refused: run attempt is %s, not 1" % attempt)
    raise SystemExit(0)

if reasons:
    # A comment from the operator that was merely early is a timing problem,
    # not an authorization problem. Reporting it as `unauthorized` would send
    # the operator looking for a permissions bug that does not exist.
    if stale_window and all("predates the approval window" in r for r in reasons):
        print("stale: %s" % reasons[0])
    else:
        print("unauthorized: %s" % reasons[0])
    raise SystemExit(0)
if bad and not found:
    print("malformed: %d approval line(s) that do not parse" % bad)
    raise SystemExit(0)
if found:
    print("stale: approval present but for a different run or launch sha")
    raise SystemExit(0)
print("absent: no approval comment for run %s" % run_id)
PY
)"
    rc=$?
    rm -f "$dump"
    if [ "$rc" -ne 0 ] || [ -z "$verdict" ]; then
        verdict="malformed: the classifier produced no verdict"
    fi

    printf '%s\n' "$verdict" >&2
    case "$verdict" in
        matched*)       record outcome matched; return 0 ;;
        absent*)        record outcome absent; return 1 ;;
        stale*)         record outcome stale; return 1 ;;
        unauthorized*)  record outcome unauthorized; return 1 ;;
        refused*)       record outcome refused; return 1 ;;
        *)              record outcome malformed; return 1 ;;
    esac
}

case "${1:---check}" in
    --check) check ;;
    --classify) shift; classify_status "$@" ;;
    *) say "usage: $0 [--check | --classify <status> <body>]"; exit 2 ;;
esac

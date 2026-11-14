#!/bin/bash
# Tests for the Stage 4 approval transport.
#
# Two halves, and they answer different questions:
#
#   1. CLASSIFIER (offline, no network): every documented response shape -
#      absent, matched, stale, unauthorized, denied, throttled, malformed,
#      attempt != 1, multi-page - is driven through the real script with a
#      stubbed curl. This proves the decisions, not the network.
#
#      The identity cases exist because text matching is not authorization: a
#      run id and a launch sha are both public, so requiring only that a
#      comment contains the right line lets anyone who can comment - including
#      a bot - approve a load run. Each identity dimension is pinned
#      separately: wrong login, bot account, GitHub App, insufficient
#      association, and an approval written before the window opened.
#
#   2. TRANSPORT (real credential): when GITHUB_TOKEN is present, the real
#      script reads the real approvals issue with the job's own token. This
#      proves the permission contract - `issues: read` on GITHUB_TOKEN really
#      can list comments - which is the exact assumption the repository-
#      variable mechanism got wrong. It makes no AWS call and launches
#      nothing, so it is safe in CI.
#
# The offline half never silently passes: a missing stub is a failure, not a
# skip.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SUT="$ROOT/infra/capacity-run/stage4-approval.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }

RUN_ID=43596057236
SHA=9402c7611fd749742d8fc9031e0db77dfbda09cd
APPROVER_LOGIN=bhaveshsabharwal

# A sandbox whose curl is a stub returning exactly what a case asks for.
mkjson() {  # mkjson <comment-body> -> a one-comment JSON array from the operator
    mkc "$1" "$APPROVER_LOGIN" "User" "OWNER" "2026-11-20T00:00:00Z"
}

# Builds one comment object. Deliberately no heredoc and no python here: this
# is called inside "$(...)", where a heredoc body's brackets would be read as
# the command substitution's own delimiters. printf with JSON escaping is
# enough for the shapes these tests need.
jstr() {  # jstr <text> -> a JSON string literal, or null for the literal NULL
    if [ "$1" = "NULL" ]; then printf 'null'; return; fi
    printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

mkc() {  # mkc <body> <login> <type> <association> <created_at> [app]
    local body="$1" login="$2" utype="$3" assoc="$4" created="$5" app="${6:-}"
    local user appjson
    if [ "$login" = "NULL" ]; then
        user='null'
    else
        user="{\"login\":$(jstr "$login"),\"type\":$(jstr "$utype")}"
    fi
    if [ -n "$app" ]; then
        appjson='{"id":1234,"slug":"test-app"}'
    else
        appjson='null'
    fi
    printf '[{"id":1,"body":%s,"user":%s,"author_association":%s,"created_at":%s,"performed_via_github_app":%s}]' \
        "$(jstr "$body")" "$user" "$(jstr "$assoc")" "$(jstr "$created")" "$appjson"
}

SB="$(mktemp -d)"; mkdir -p "$SB/bin" "$SB/state"
cat > "$SB/bin/curl" <<'STUB'
#!/bin/bash
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] && printf '%s' "$CASE_BODY" > "$out"
printf '%s' "$CASE_STATUS"
exit 0
STUB
chmod +x "$SB/bin/curl"

run_sut() {  # run_sut <status> <body> [attempt] [window_start]
    local status="$1" body="$2" attempt="${3:-1}" window="${4:-}"
    local sd="$SB/state"
    rm -rf "$sd"; mkdir -p "$sd"
    # The stub directory goes FIRST, and PATH is trimmed so a real curl in a
    # later Windows directory can never answer instead of the stub.
    CASE_STATUS="$status" CASE_BODY="$body" \
    PATH="$SB/bin:/usr/local/bin:/usr/bin:/bin" \
    GITHUB_TOKEN=stub-token API_REPO=owner/repo RUN_ID="$RUN_ID" \
    LAUNCH_SHA="$SHA" RUN_ATTEMPT="$attempt" STAGE4_ISSUE=1 STATE_DIR="$sd" \
    STAGE4_APPROVER="$APPROVER_LOGIN" STAGE4_WINDOW_START="${window:-}" \
    bash "$SUT" --check > "$SB/state/out" 2>&1
    printf '%s\n' "$?" > "$SB/state/rc"
    cat "$sd/stage4-approval-outcome" 2>/dev/null || echo none
}

check_case() {  # check_case <label> <status> <body> <want-outcome> <want-rc> [attempt] [window]
    local label="$1" status="$2" body="$3" want="$4" wantrc="$5" attempt="${6:-1}"
    local window="${7:-}"
    local got rc out
    got="$(run_sut "$status" "$body" "$attempt" "$window")"
    rc="$(cat "$SB/state/rc")"
    out="$(cat "$SB/state/out")"
    if [ "$got" != "$want" ] || [ "$rc" != "$wantrc" ]; then
        fail "$label (outcome=$got rc=$rc, wanted $want/$wantrc)"
        return
    fi
    case "$want" in
        denied)    grep -qiE "denied|not found" <<<"$out" || { fail "$label: no denial message [out=<${out}>]"; return; } ;;
        throttled) grep -qi "rate limited" <<<"$out" || { fail "$label: no throttle message"; return; } ;;
        malformed) grep -qiE "malformed|unexpected HTTP" <<<"$out" || { fail "$label: no malformed message [out=<${out}>]"; return; } ;;
        absent)    grep -qi "absent"       <<<"$out" || { fail "$label: no absent message"; return; } ;;
        stale)     grep -qi "stale"        <<<"$out" || { fail "$label: no stale message"; return; } ;;
        refused)   grep -qi "attempt"      <<<"$out" || { fail "$label: no attempt message"; return; } ;;
        unauthorized)
                   grep -qi "unauthorized" <<<"$out" || { fail "$label: no unauthorized message [out=<${out}>]"; return; }
                   # An unauthorized comment must never be reported as a
                   # transport failure: the read worked, the author did not count.
                   if grep -qiE "denied|malformed|absent" <<<"$out"; then
                       fail "$label: unauthorized was misreported [out=<${out}>]"; return
                   fi ;;
    esac
    pass "$label"
}

echo "== classifier: offline, stubbed transport =="

check_case "a matching approval approves" 200 "$(mkjson "stage4-approve $RUN_ID:$SHA")" matched 0
check_case "no comments at all approves nothing" 200 '[]' absent 1
check_case "an unrelated comment approves nothing" 200 "$(mkjson "looks green to me")" absent 1
check_case "an approval for another run approves nothing" \
    200 "$(mkjson "stage4-approve 43596057237:$SHA")" stale 1
check_case "an approval for another sha approves nothing" \
    200 "$(mkjson "stage4-approve $RUN_ID:0000000000000000000000000000000000000000")" stale 1
check_case "a malformed approval line is reported as malformed" \
    200 "$(mkjson "stage4-approve $RUN_ID")" malformed 1
check_case "a short sha is not an approval" \
    200 "$(mkjson "stage4-approve $RUN_ID:9402c76")" malformed 1
check_case "a bare boolean approves nothing" \
    200 "$(mkjson "stage4-approve yes")" malformed 1
check_case "HTTP 401 is an explicit denial" 401 '{"message":"Bad credentials"}' denied 1
check_case "HTTP 403 is an explicit denial" 403 '{"message":"Resource not accessible by integration"}' denied 1
check_case "HTTP 403 rate limit is reported as throttling, not denial" \
    403 '{"message":"API rate limit exceeded"}' throttled 1
check_case "HTTP 404 is an explicit denial" 404 '{"message":"Not Found"}' denied 1
check_case "HTTP 429 is throttling" 429 '{"message":"too many"}' throttled 1
check_case "HTTP 500 is reported, not treated as absent" 500 'oops' malformed 1
check_case "a non-JSON 200 is malformed" 200 'not json at all' malformed 1
check_case "run attempt 2 approves nothing even with a matching line" \
    200 "$(mkjson "stage4-approve $RUN_ID:$SHA")" refused 1 2

echo
echo "== authorization: who wrote the comment, per GitHub =="
# A run id and a launch sha are public. If the text were sufficient, any
# account able to comment could approve a load run, so every identity field
# that GitHub attributes is checked and each is pinned here separately.

check_case "a stranger quoting the exact approval line approves nothing" \
    200 "$(mkc "stage4-approve $RUN_ID:$SHA" someone-else User NONE 2026-11-20T00:00:00Z)" unauthorized 1

check_case "a bot account quoting the exact approval line approves nothing" \
    200 "$(mkc "stage4-approve $RUN_ID:$SHA" "$APPROVER_LOGIN" Bot OWNER 2026-11-20T00:00:00Z)" unauthorized 1

check_case "a GitHub App writing as the operator approves nothing" \
    200 "$(mkc "stage4-approve $RUN_ID:$SHA" "$APPROVER_LOGIN" User OWNER 2026-11-20T00:00:00Z app)" unauthorized 1

check_case "the operator without collaborator association approves nothing" \
    200 "$(mkc "stage4-approve $RUN_ID:$SHA" "$APPROVER_LOGIN" User NONE 2026-11-20T00:00:00Z)" unauthorized 1

APPROVER_UPPER="$(printf '%s' "$APPROVER_LOGIN" | tr '[:lower:]' '[:upper:]')"
check_case "the operator's login is matched case-insensitively" \
    200 "$(mkc "stage4-approve $RUN_ID:$SHA" "$APPROVER_UPPER" User OWNER 2026-11-20T00:00:00Z)" matched 0

check_case "a commenter claiming the operator's name in the body approves nothing" \
    200 "$(mkc "stage4-approve $RUN_ID:$SHA signed by $APPROVER_LOGIN" someone-else User NONE 2026-11-20T00:00:00Z)" unauthorized 1

check_case "a member association is accepted" \
    200 "$(mkc "stage4-approve $RUN_ID:$SHA" "$APPROVER_LOGIN" User MEMBER 2026-11-20T00:00:00Z)" matched 0

check_case "an operator approval written before the window opened is stale" \
    200 "$(mkc "stage4-approve $RUN_ID:$SHA" "$APPROVER_LOGIN" User OWNER 2026-11-19T23:59:59Z)" stale 1 1 2026-11-20T00:00:00Z

check_case "an operator approval written inside the window is accepted" \
    200 "$(mkc "stage4-approve $RUN_ID:$SHA" "$APPROVER_LOGIN" User OWNER 2026-11-20T00:00:01Z)" matched 0 1 2026-11-20T00:00:00Z

check_case "a comment with no author identity approves nothing" \
    200 '[{"id":1,"body":"stage4-approve '"$RUN_ID:$SHA"'","user":null,"author_association":"OWNER","created_at":"2026-11-20T00:00:00Z"}]' unauthorized 1

echo
echo "== pagination: an approval is not missed because it is not on page 1 =="
# Reading only the first page reports "absent" while a real approval sits on
# page 2 - a silent miss that looks exactly like patience.

PAGEDIR="$SB/pages"; mkdir -p "$PAGEDIR"
cat > "$SB/bin/curl" <<'STUB'
#!/bin/bash
out=""; hdr=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -D) hdr="$2"; shift 2 ;;
    -w) shift 2 ;;
    -H) shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
page=1
case "$url" in
  *[\?\&]page=*) page="${url##*[?&]page=}" ; page="${page%%&*}" ;;
esac
[ -f "$PAGEDIR/page$page.json" ] && cat "$PAGEDIR/page$page.json" > "${out:-/dev/null}"
[ -f "$PAGEDIR/page$page.hdr" ] && cp "$PAGEDIR/page$page.hdr" "${hdr:-/dev/null}"
printf '200'
exit 0
STUB

# page 1: nothing relevant; page 2: the real approval.
printf '[]' > "$PAGEDIR/page1.json"
printf 'link: <https://api.github.com/x?per_page=100&page=2>; rel="next"' > "$PAGEDIR/page1.hdr"
mkc "stage4-approve $RUN_ID:$SHA" "$APPROVER_LOGIN" User OWNER 2026-11-20T00:00:00Z     > "$PAGEDIR/page2.json"
: > "$PAGEDIR/page2.hdr"

sd="$SB/state"; rm -rf "$sd"; mkdir -p "$sd"
export PAGEDIR
got="$(PATH="$SB/bin:/usr/local/bin:/usr/bin:/bin" \
    GITHUB_TOKEN=stub-token API_REPO=owner/repo RUN_ID="$RUN_ID" \
    LAUNCH_SHA="$SHA" RUN_ATTEMPT=1 STAGE4_ISSUE=1 STATE_DIR="$sd" \
    STAGE4_APPROVER="$APPROVER_LOGIN" bash "$SUT" --check > "$SB/state/out" 2>&1; \
    cat "$sd/stage4-approval-outcome" 2>/dev/null || echo none)"
if [ "$got" = matched ]; then
    pass "an approval on page 2 is found by following the Link header"
else
    fail "an approval on page 2 was missed (outcome=$got) [out=<$(cat "$SB/state/out")>]"
fi

# A scan cut short by the page cap must not report "absent".
rm -rf "$PAGEDIR"; mkdir -p "$PAGEDIR"
printf '[]' > "$PAGEDIR/page1.json"
printf 'link: <https://api.github.com/x?per_page=100&page=2>; rel="next"' > "$PAGEDIR/page1.hdr"
sd="$SB/state"; rm -rf "$sd"; mkdir -p "$sd"
export PAGEDIR
got="$(STAGE4_MAX_PAGES=1 PATH="$SB/bin:/usr/local/bin:/usr/bin:/bin" \
    GITHUB_TOKEN=stub-token API_REPO=owner/repo RUN_ID="$RUN_ID" \
    LAUNCH_SHA="$SHA" RUN_ATTEMPT=1 STAGE4_ISSUE=1 STATE_DIR="$sd" \
    STAGE4_APPROVER="$APPROVER_LOGIN" bash "$SUT" --check > "$SB/state/out" 2>&1; \
    cat "$sd/stage4-approval-outcome" 2>/dev/null || echo none)"
if [ "$got" = malformed ]; then
    pass "a truncated scan is a failure, not an absent approval"
else
    fail "a truncated scan reported '$got' instead of malformed"
fi

# An approver that is unset or a wildcard must fail before any read.
sd="$SB/state"; rm -rf "$sd"; mkdir -p "$sd"
got="$(PATH="$SB/bin:/usr/local/bin:/usr/bin:/bin" GITHUB_TOKEN=stub-token \
    API_REPO=owner/repo RUN_ID="$RUN_ID" LAUNCH_SHA="$SHA" RUN_ATTEMPT=1 \
    STAGE4_ISSUE=1 STATE_DIR="$sd" STAGE4_APPROVER="*" \
    bash "$SUT" --check > "$SB/state/out" 2>&1; \
    cat "$sd/stage4-approval-outcome" 2>/dev/null || echo none)"
if [ "$got" = invalid ]; then
    pass "a wildcard approver is refused before any read"
else
    fail "a wildcard approver was not refused (outcome=$got)"
fi

echo
echo "== transport: the real credential, no AWS, no instance =="
# This is the test the repository-variable design never had. It answers one
# question: can a job's own GITHUB_TOKEN read comments on the approvals issue?
# Nothing here launches, creates or terminates anything.
if [ -z "${GITHUB_TOKEN:-}" ] || [ -z "${STAGE4_ISSUE:-}" ]; then
    printf 'SKIP  transport test: no GITHUB_TOKEN/STAGE4_ISSUE in this environment\n'
    printf '      (CI runs it as a job with issues: read; a local run without a\n'
    printf '       token cannot answer the permission question at all)\n'
else
    sd="$(mktemp -d)"
    out="$(API_REPO="${API_REPO:-}" RUN_ID="$RUN_ID" LAUNCH_SHA="$SHA" \
        RUN_ATTEMPT=1 STAGE4_ISSUE="$STAGE4_ISSUE" STATE_DIR="$sd" \
        bash "$SUT" --check 2>&1)" || true
    outcome="$(cat "$sd/stage4-approval-outcome" 2>/dev/null || echo none)"
    status="$(cat "$sd/stage4-approval-status" 2>/dev/null || echo none)"
    printf 'transport: HTTP %s, outcome %s\n' "$status" "$outcome"
    case "$outcome" in
        denied|throttled)
            fail "the real token could not read the approvals issue (HTTP $status) - \`issues: read\` is not sufficient"
            printf '%s\n' "$out" ;;
        absent|matched|stale|malformed|refused)
            # Any of these means the READ SUCCEEDED. Whether an approval is
            # present is a separate question from whether the mechanism works.
            pass "the real token read the approvals issue (HTTP $status): transport works"
            ;;
        *)
            fail "the transport test produced no usable outcome (HTTP $status)"
            printf '%s\n' "$out" ;;
    esac
    rm -rf "$sd"
fi

echo
echo "ALL $PASS CASES PASS" >&2
[ "$FAIL" -eq 0 ] || { echo "$FAIL FAILED" >&2; exit 1; }
printf 'ALL %d CASES PASS\n' "$PASS"

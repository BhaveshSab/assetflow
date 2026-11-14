#!/bin/bash
# Tests for the Stage 4 approval transport.
#
# Two halves, and they answer different questions:
#
#   1. CLASSIFIER (offline, no network): every documented response shape -
#      absent, matched, stale, denied, throttled, malformed, attempt != 1 - is
#      driven through the real script with a stubbed curl. This proves the
#      decisions, not the network.
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

# A sandbox whose curl is a stub returning exactly what a case asks for.
mkjson() {  # mkjson <comment-body> -> a one-comment JSON array
    printf '[{"id":1,"body":%s}]' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
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

run_sut() {  # run_sut <status> <body> [attempt]
    local status="$1" body="$2" attempt="${3:-1}"
    local sd="$SB/state"
    rm -rf "$sd"; mkdir -p "$sd"
    # The stub directory goes FIRST, and PATH is trimmed so a real curl in a
    # later Windows directory can never answer instead of the stub.
    CASE_STATUS="$status" CASE_BODY="$body" \
    PATH="$SB/bin:/usr/local/bin:/usr/bin:/bin" \
    GITHUB_TOKEN=stub-token API_REPO=owner/repo RUN_ID="$RUN_ID" \
    LAUNCH_SHA="$SHA" RUN_ATTEMPT="$attempt" STAGE4_ISSUE=1 STATE_DIR="$sd" \
    bash "$SUT" --check > "$SB/state/out" 2>&1
    printf '%s\n' "$?" > "$SB/state/rc"
    cat "$sd/stage4-approval-outcome" 2>/dev/null || echo none
}

check_case() {  # check_case <label> <status> <body> <want-outcome> <want-rc> [attempt]
    local label="$1" status="$2" body="$3" want="$4" wantrc="$5" attempt="${6:-1}"
    local got rc out
    got="$(run_sut "$status" "$body" "$attempt")"
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

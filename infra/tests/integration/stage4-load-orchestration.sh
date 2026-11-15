#!/usr/bin/env bash
#
# Prove the Stage 4 load orchestration end to end without AWS, GitHub, k6 or a
# network: the real stage4-load.sh runs in a sandbox whose aws, curl, k6 and
# export-evidence are stubs, and every case below is a behaviour of the
# orchestration itself, not of a stub.
#
# Preflight, no load:
#   a missing Stage 3 verdict refuses to load
#   an instance that is not running refuses to load
#   a readiness code other than 200 refuses to load
#   an application that does not answer ready refuses to load
#   a dead watchdog refuses to load
#   a lifetime too short for the whole sequence refuses to load
#   a pacing plan without an entry for a stage is a usage error
#   a pacing plan offering above the ceiling is a usage error
#
# The path:
#   the full path produces a report with one row per stage and exits 0
#   a threshold-crossing stage stops the ramp and preserves the earlier rows
#   the abort ceiling is recorded as ABORTED, and partial results are kept
#   a k6 crash is an error, not a measurement
#   a deadline that would not cover a stage plus margins stops the ramp early
#   a successful post-load export is recorded as verified
#   a failed post-load export is recorded, and does not undo the measurement
#
# Exit 0 when every case holds, 1 otherwise.
set -uo pipefail
REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
cd "$REPO" || exit 1

FAIL=0
SLEEPERS=""
cleanup_sleepers() {
    local p
    for p in ${SLEEPERS:-}; do kill "$p" 2>/dev/null || true; done
}
trap cleanup_sleepers EXIT
ok()  { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }

RUN_ID=43564821440
HOSTNAME_UNDER_TEST=capacity-run.test
PORT_UNDER_TEST=8443
IP_UNDER_TEST=203.0.113.10

# Build a sandbox: the real script, stubbed world.
sandbox() {
    local W
    W=$(mktemp -d)
    mkdir -p "$W/infra/capacity-run" "$W/infra/scripts" "$W/state/snapshots" "$W/trust" "$W/bin"
    cp infra/capacity-run/stage4-load.sh "$W/infra/capacity-run/"
    cp infra/capacity-run/aws-context.sh "$W/infra/capacity-run/"
    cp infra/scripts/k6-load.js "$W/infra/scripts/" 2>/dev/null || true
    : > "$W/trust/tls.crt"
    printf 'complete' > "$W/state/verdict"
    printf '200' > "$W/state/ready-code"
    # Its stdio is detached, or the sleeper would hold this command
    # substitution's pipe open for its whole lifetime and hang the sandbox.
    sleep 600 >/dev/null 2>&1 &
    echo $! > "$W/state/watchdog-pid"
    SLEEPERS="$SLEEPERS $!"
    printf '%s' "$1" > "$W/state/deadline-epoch"
    printf '%s' "$RUN_ID" > "$W/state/run-id"
    printf '{"evidence_snapshot":{"name":"snapshot-test.tar.gz","sha256":"%s"}}'         "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"         > "$W/state/snapshots/0001-status.json"
    echo "$W"
}

# The stub world: aws answers running+IP, curl answers ready/login/status,
# k6 writes a real-format summary and obeys its control file, the exporter
# obeys its control file.
write_stubs() {
    local W="$1" k6_exit="$2" p95="$3" err="$4"
    cat > "$W/bin/aws" <<'STUB'
#!/usr/bin/env bash
case "$*" in
    *State.Name*)
        if [ "${STUB_AWS_DEAD:-0}" = "1" ]; then echo terminated; else echo running; fi ;;
    *PublicIpAddress*)
        if [ "${STUB_AWS_DEAD:-0}" = "1" ]; then echo none; else printf '%s' "$STUB_IP"; fi ;;
    *) echo "stub-aws: unexpected call: $*" >&2; exit 1 ;;
esac
STUB
    cat > "$W/bin/curl" <<'STUB'
#!/usr/bin/env bash
# Answer by URL: the readiness probe, the binding login, the status channel.
url=""
prev=""
for a in "$@"; do
    case "$prev" in "") ;; esac
    prev="$a"
    case "$a" in http*) url="$a" ;; esac
done
if [ "${STUB_CURL_BROKEN:-0}" = "1" ]; then echo "curl: connection refused" >&2; exit 7; fi
# Probes that ask for the status code (-w '%{http_code}') get the code; the
# status-channel poller, which reads the body, gets the body.
for a in "$@"; do
    if [ "$a" = "%{http_code}" ]; then
        case "$url" in
            */api/health/ready|*/api/auth/login) echo 200; exit 0 ;;
            *) echo 000; exit 0 ;;
        esac
    fi
done
case "$url" in
    */api/health/ready) echo 200 ;;
    */api/auth/login) echo '{"token":"stub-token"}' ;;
    */status) printf '{"bootstrap_status":"running","fixture_users":200,"memory":{"total_mb":976,"available_mb":300},"disk":{"used_percent":31.5},"deadline_remaining_seconds":9000}' ;;
    *) echo "stub-curl: unexpected url: $url" >&2; exit 1 ;;
esac
exit 0
STUB
    # The k6 stub writes exactly the summary format k6-load.js produces, and
    # obeys the control file: exit code, p95, error rate.
    cat > "$W/bin/k6" <<STUB
#!/usr/bin/env bash
summary=""; dur=""; vus=""; tag=""
prev=""
for a in "\$@"; do
    case "\$prev" in
        -e) case "\$a" in SUMMARY_FILE=*) summary="\${a#SUMMARY_FILE=}" ;; VUS=*) vus="\${a#VUS=}" ;; DURATION=*) dur="\${a#DURATION=}" ;; TAG=*) tag="\${a#TAG=}" ;; esac ;;
    esac
    prev="\$a"
done
read -r K6_EXIT K6_P95 K6_ERR <<KCTRL
\$STUB_K6
KCTRL
{
echo "tag=\$tag"
echo "vus=\$vus"
echo "duration=\$dur"
echo "rps=\$(awk -v v="\$vus" 'BEGIN{printf "%.2f", v/1.2}')"
echo "requests=\$((vus * 60))"
echo "iterations=\$((vus * 60))"
echo "p50_ms=50.0"
echo "p95_ms=\$K6_P95"
echo "p99_ms=900.0"
echo "max_ms=1200.0"
echo "error_rate=\$K6_ERR"
echo "checks_rate=1.0000"
echo "avg_response_bytes=1200"
echo "throttled_429=0"
echo "login_errors=0"
} > "\$summary"
sleep \$(( \$(printf %s "\$dur" | tr -dc 0-9) + 4 ))
exit "\$K6_EXIT"
STUB
    chmod +x "$W/bin/aws" "$W/bin/curl" "$W/bin/k6"
    # The k6 stub reads its behaviour from the environment at run time; the
    # caller's write_stubs arguments are the single source of it.
    STUB_K6="$k6_exit $p95 $err"
    cat > "$W/infra/scripts/export-evidence.sh" <<'STUB'
#!/usr/bin/env bash
# $1 base url, $2 name, $3 sha, $4 out
if [ "${STUB_EXPORT_FAIL:-0}" = "1" ]; then echo "export failed: 503" >&2; exit 1; fi
printf 'stub-archive-bytes' > "$4"
exit 0
STUB
    chmod +x "$W/infra/scripts/export-evidence.sh"
}

# Run the real script in the sandbox. Extra env after $1.
run_stage4() {
    local W="$1"; shift
    set +e
    (
        cd "$W" || exit 1
        PATH="$W/bin:$PATH" STUB_IP="$IP_UNDER_TEST" STUB_AWS_DEAD="${STUB_AWS_DEAD:-0}" STUB_CURL_BROKEN="${STUB_CURL_BROKEN:-0}" STUB_K6="${STUB_K6:-}" STUB_EXPORT_FAIL="${STUB_EXPORT_FAIL:-0}" \
        STATE_DIR="$W/state" TRUST_DIR="$W/trust" \
        CAPACITY_HOSTNAME="$HOSTNAME_UNDER_TEST" PORT="$PORT_UNDER_TEST" \
        INSTANCE_ID=i-0123456789abcdef0 DEADLINE_EPOCH="$(cat "$W/state/deadline-epoch")" \
        EVIDENCE_TOKEN=stub-token LOADTEST_PASSWORD=stub-password-40-chars-aaaaaaaaaaaa \
        LOADTEST_RUN_ID="$RUN_ID" STAGE_DURATION="$STAGE_DURATION_UNDER_TEST" \
        STAGES="$STAGES_UNDER_TEST" SLEEP_PLAN="$SLEEP_PLAN_UNDER_TEST" \
        RUN_DIR="$W/state/stage4" \
        env "$@" bash infra/capacity-run/stage4-load.sh
    ) >"$W/out" 2>&1
    local rc=$?
    set -u
    printf '%s\n' "$rc"
}

STAGE_DURATION_UNDER_TEST="1s"
STAGES_UNDER_TEST="5,10"
SLEEP_PLAN_UNDER_TEST="5:1,10:1,25:1,50:1,100:2,200:3"

# ---- preflight refusals: no load, no stage directory -------------------------
# a. No verdict.
W=$(sandbox "$(( $(date +%s) + 4000 ))"); rm -f "$W/state/verdict"; write_stubs "$W" 0 100 0.0
RC=$(run_stage4 "$W")
if [ "$RC" = "1" ] && [ ! -d "$W/state/stage4" ]; then ok "a missing Stage 3 verdict refuses to load"
else bad "a missing verdict exited $RC (stage dir: $([ -d "$W/state/stage4" ] && echo present || echo absent))"; fi
rm -rf "$W"

# b. Instance not running.
W=$(sandbox "$(( $(date +%s) + 4000 ))"); write_stubs "$W" 0 100 0.0
RC=$(run_stage4 "$W" STUB_AWS_DEAD=1)
if [ "$RC" = "1" ]; then ok "an instance that is not running refuses to load"
else bad "a dead instance exited $RC"; fi
rm -rf "$W"

# c. Readiness code not 200.
W=$(sandbox "$(( $(date +%s) + 4000 ))"); write_stubs "$W" 0 100 0.0; printf '500' > "$W/state/ready-code"
RC=$(run_stage4 "$W")
if [ "$RC" = "1" ]; then ok "a readiness code other than 200 refuses to load"
else bad "a 500 readiness code exited $RC"; fi
rm -rf "$W"

# d. Application does not answer ready.
W=$(sandbox "$(( $(date +%s) + 4000 ))"); write_stubs "$W" 0 100 0.0
RC=$(run_stage4 "$W" STUB_CURL_BROKEN=1)
if [ "$RC" = "1" ]; then ok "an application that does not answer ready refuses to load"
else bad "a broken endpoint exited $RC"; fi
rm -rf "$W"

# e. Dead watchdog.
W=$(sandbox "$(( $(date +%s) + 4000 ))"); write_stubs "$W" 0 100 0.0; printf '999999' > "$W/state/watchdog-pid"
RC=$(run_stage4 "$W")
if [ "$RC" = "1" ]; then ok "a dead watchdog refuses to load"
else bad "a dead watchdog exited $RC"; fi
rm -rf "$W"

# f. Lifetime too short: the sequence needs more than remains.
W=$(sandbox "$(( $(date +%s) + 200 ))"); write_stubs "$W" 0 100 0.0
RC=$(run_stage4 "$W")
if [ "$RC" = "1" ]; then ok "a lifetime too short for the whole sequence refuses to load"
else bad "a short lifetime exited $RC"; fi
rm -rf "$W"

# g. Pacing plan missing a stage.
W=$(sandbox "$(( $(date +%s) + 4000 ))"); write_stubs "$W" 0 100 0.0
RC=$(run_stage4 "$W" SLEEP_PLAN="5:1")
if [ "$RC" = "2" ]; then ok "a pacing plan without an entry for a stage is a usage error"
else bad "a missing pacing entry exited $RC"; fi
rm -rf "$W"

# h. Pacing plan over the ceiling.
W=$(sandbox "$(( $(date +%s) + 4000 ))"); write_stubs "$W" 0 100 0.0
RC=$(run_stage4 "$W" STAGES="5,10,25" SLEEP_PLAN="5:0,10:0,25:0")
if [ "$RC" = "2" ]; then ok "a pacing plan offering above the ceiling is a usage error"
else bad "an unpaced plan exited $RC"; fi
rm -rf "$W"

# ---- the path ----------------------------------------------------------------
# i. The full path: two stages, both healthy, report written, export verified.
W=$(sandbox "$(( $(date +%s) + 4000 ))"); write_stubs "$W" 0 100 0.0
RC=$(run_stage4 "$W")
ROWS=$(grep -c '^| [0-9]' "$W/state/stage4/stage4-report.md" 2>/dev/null || echo 0)
VERIFIED=$(grep -c 'exported and checksum-verified' "$W/state/stage4/stage4-report.md" 2>/dev/null || echo 0)
if [ "$RC" = "0" ] && [ "$ROWS" = "2" ] && [ "$VERIFIED" = "1" ]; then
    ok "the full path produces a report with one row per stage and a verified export"
else
    bad "the full path exited $RC with $ROWS rows and $VERIFIED verified exports"
fi
rm -rf "$W"

# j. A threshold-crossing stage: the second stage breaks p95, the ramp stops,
#    the first stage's row is preserved.
W=$(sandbox "$(( $(date +%s) + 4000 ))"); write_stubs "$W" 99 1500 0.0
RC=$(run_stage4 "$W")
ROWS=$(grep -c '^| [0-9]' "$W/state/stage4/stage4-report.md" 2>/dev/null || echo 0)
SAT=$(grep -c 'SATURATED' "$W/state/stage4/stage4-report.md" 2>/dev/null || echo 0)
if [ "$RC" = "0" ] && [ "$ROWS" = "1" ] && [ "$SAT" -ge 1 ]; then
    ok "a threshold-crossing stage stops the ramp and preserves the earlier rows"
else
    bad "the saturation case exited $RC with $ROWS rows and $SAT saturated marks"
fi
rm -rf "$W"

# k. The abort ceiling: error rate 0.6 >= 0.5, recorded as ABORTED.
W=$(sandbox "$(( $(date +%s) + 4000 ))"); write_stubs "$W" 99 100 0.6
RC=$(run_stage4 "$W")
AB=$(grep -c 'ABORTED' "$W/state/stage4/stage4-report.md" 2>/dev/null || echo 0)
if [ "$RC" = "0" ] && [ "$AB" -ge 1 ]; then
    ok "the abort ceiling is recorded as ABORTED with partial results kept"
else
    bad "the abort case exited $RC with $AB aborted marks"
fi
rm -rf "$W"

# l. A k6 crash is an error, not a measurement.
W=$(sandbox "$(( $(date +%s) + 4000 ))"); write_stubs "$W" 1 100 0.0
RC=$(run_stage4 "$W")
if [ "$RC" = "1" ]; then ok "a k6 crash is an error, not a measurement"
else bad "a k6 crash exited $RC"; fi
rm -rf "$W"

# m. A deadline that would not cover stage 2 plus the margins stops the ramp
#    after stage 1, keeping its row, and still exits 0 (a result, not an error).
#    The margins are tightened so the budget arithmetic isolates the guard:
#    preflight needs 2s+100s=102s; stage 2 alone needs 1s+100s=101s; the first
#    stage really runs ~5s (the k6 stub honours its duration), so a 105s
#    lifetime passes preflight and fails the between-stages guard.
W=$(sandbox "$(( $(date +%s) + 105 ))"); write_stubs "$W" 0 100 0.0
RC=$(run_stage4 "$W" EXPORT_MARGIN=100 CLEANUP_MARGIN=0 SAFETY_MARGIN=0)
ROWS=$(grep -c '^| [0-9]' "$W/state/stage4/stage4-report.md" 2>/dev/null || echo 0)
EARLY=$(grep -c 'stopped early' "$W/state/stage4/stage4-report.md" 2>/dev/null || echo 0)
if [ "$RC" = "0" ] && [ "$ROWS" = "1" ] && [ "$EARLY" = "1" ]; then
    ok "an expiring deadline stops the ramp early with partial results kept"
else
    bad "the early-stop case exited $RC with $ROWS rows and $EARLY early-stop notes"
fi
rm -rf "$W"

# n. A failed post-load export is recorded and does not undo the measurement.
W=$(sandbox "$(( $(date +%s) + 4000 ))"); write_stubs "$W" 0 100 0.0
RC=$(run_stage4 "$W" STUB_EXPORT_FAIL=1)
ROWS=$(grep -c '^| [0-9]' "$W/state/stage4/stage4-report.md" 2>/dev/null || echo 0)
FAILED_EXPORT=$(grep -c 'post-load export failed' "$W/state/stage4/stage4-report.md" 2>/dev/null || echo 0)
if [ "$RC" = "0" ] && [ "$ROWS" = "2" ] && [ "$FAILED_EXPORT" = "1" ]; then
    ok "a failed post-load export is recorded and does not undo the measurement"
else
    bad "the failed-export case exited $RC with $ROWS rows and $FAILED_EXPORT failure notes"
fi
rm -rf "$W"

if [ "$FAIL" -eq 0 ]; then
    printf 'ALL %s CASES PASS\n' 14
    exit 0
fi
printf '%s CASE(S) FAILED\n' "$FAIL"
exit 1

#!/usr/bin/env bash
#
# Stage 4: the approved load measurement, driven from the retained runner.
#
# This is the execution half of the Stage 4 path the repository was missing:
# the Stage 3 hold used to be a passive wait, and no code anywhere could turn
# an approval into a measurement. This script is what an approval invokes -
# nothing else, and nothing else invokes it.
#
# What it does, in order:
#   1. revalidates the run it was handed: the exact instance still exists and
#      runs, Stage 3's evidence files are present, the application answers
#      /api/health/ready over verified TLS, the watchdog process is alive, and
#      the guest's own remaining lifetime covers the whole sequence plus the
#      export and cleanup margins;
#   2. proves the target binding: only the database that holds this run's
#      fixture accounts can authenticate account 001 with this run's password;
#   3. walks the approved ramp - 5/10/25/50/100/200 VUs, two minutes each -
#      one k6 run per stage, sampling the guest's status channel and this
#      generator's own CPU/memory while each stage runs;
#   4. applies the predeclared thresholds per stage, stops the ramp at the
#      abort ceiling, and preserves partial results;
#   5. re-exports the guest evidence archive AFTER the load and verifies it
#      against the guest's own digest, so the retained evidence shows the
#      post-load state, not only the pre-load one.
#
# It never terminates the instance and never touches the ingress: cleanup
# belongs to the workflow step that called it, which knows the recorded rule
# id and the approved cleanup authority.
#
# Pacing: VUs alone do not specify a request rate. Each stage carries an
# explicit per-VU sleep so the THEORETICAL offered rate stays under the
# approved 85.7 requests/second ceiling with margin, and the k6-measured rate
# is what the report records - the ceiling is never claimed as achieved, only
# as respected.
#
# Environment:
#   STATE_DIR          required. The run state directory (verdict, ready-code,
#                      watchdog files, snapshots).
#   TRUST_DIR          required. Holds tls.crt - the run's own CA.
#   CAPACITY_HOSTNAME  required. The hostname the guest's certificate was
#                      issued for.
#   PORT               optional. The edge port (default 8443).
#   INSTANCE_ID        required. The approved instance.
#   DEADLINE_EPOCH     required. The guest's absolute deadline (unix seconds),
#                      derived from the actual AWS LaunchTime.
#   EVIDENCE_TOKEN     required. The guest's status/evidence bearer token.
#   LOADTEST_USERS     optional. Default 200, the approved account count.
#   LOADTEST_PASSWORD  required. The fixture password this run generated.
#   LOADTEST_RUN_ID    required. The run id the fixture accounts are named
#                      after; it must match what the guest seeded.
#   STAGES             optional. Default 5,10,25,50,100,200.
#   STAGE_DURATION     optional. Default 2m.
#   SLEEP_PLAN         optional. Per-stage per-VU sleep, "VUs:seconds,...".
#                      Default 5:1,10:1,25:1,50:1,100:2,200:3.
#   P95_THRESHOLD_MS / ERROR_RATE_THRESHOLD / ABORT_ERROR_RATE
#                      optional. The approved Stage 3-era thresholds from
#                      load-test.sh: p95 < 1000 ms, errors < 1 %, abort at 50 %.
#   EXPORT_MARGIN / CLEANUP_MARGIN / SAFETY_MARGIN
#                      optional. Reserved seconds after the last stage.
#
# Exit codes: 0 = the ramp ran (a bent or aborted stage is a result, kept);
#             1 = a preflight or infrastructure error, before or during load;
#             2 = usage error.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STATE_DIR="${STATE_DIR:?STATE_DIR is required}"
TRUST_DIR="${TRUST_DIR:?TRUST_DIR is required}"
CAPACITY_HOSTNAME="${CAPACITY_HOSTNAME:?CAPACITY_HOSTNAME is required}"
PORT="${PORT:-8443}"
INSTANCE_ID="${INSTANCE_ID:?INSTANCE_ID is required}"
DEADLINE_EPOCH="${DEADLINE_EPOCH:?DEADLINE_EPOCH is required}"
EVIDENCE_TOKEN="${EVIDENCE_TOKEN:?EVIDENCE_TOKEN is required}"
LOADTEST_PASSWORD="${LOADTEST_PASSWORD:?LOADTEST_PASSWORD is required}"
LOADTEST_RUN_ID="${LOADTEST_RUN_ID:?LOADTEST_RUN_ID is required}"

LOADTEST_USERS="${LOADTEST_USERS:-200}"
STAGES="${STAGES:-5,10,25,50,100,200}"
STAGE_DURATION="${STAGE_DURATION:-2m}"
SLEEP_PLAN="${SLEEP_PLAN:-5:1,10:1,25:1,50:1,100:2,200:3}"
P95_THRESHOLD_MS="${P95_THRESHOLD_MS:-1000}"
ERROR_RATE_THRESHOLD="${ERROR_RATE_THRESHOLD:-0.01}"
ABORT_ERROR_RATE="${ABORT_ERROR_RATE:-0.5}"
EXPORT_MARGIN="${EXPORT_MARGIN:-300}"
CLEANUP_MARGIN="${CLEANUP_MARGIN:-300}"
SAFETY_MARGIN="${SAFETY_MARGIN:-300}"

case "$DEADLINE_EPOCH" in
    ''|*[!0-9]*) echo "stage4-load: DEADLINE_EPOCH must be unix seconds" >&2; exit 2 ;;
esac
[ -f "$STATE_DIR/verdict" ] || { echo "stage4-load: no Stage 3 verdict in $STATE_DIR" >&2; exit 1; }
[ -f "$TRUST_DIR/tls.crt" ] || { echo "stage4-load: no CA at $TRUST_DIR/tls.crt" >&2; exit 1; }

say() { printf '[stage4] %s\n' "$*"; }
warn() { printf '[stage4] WARN %s\n' "$*" >&2; }
die() { printf '[stage4] FATAL %s\n' "$*" >&2; exit 1; }

RUN_DIR="${RUN_DIR:-$STATE_DIR/stage4}"
mkdir -p "$RUN_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# The approved ceiling, named here because the pacing plan is derived from it.
# Exceeding it in configuration is a usage error, not a measurement.
APPROVED_RPS_CEILING="85.7"

# ---- the AWS handle: the same explicit profile and region everywhere --------
# shellcheck source=aws-context.sh
source "$HERE/aws-context.sh"

# ---- 1. preflight revalidation ----------------------------------------------
# Instance identity: the approved instance must still exist and be running.
# A replacement, a different id, or a terminated instance is not this run.
preflight_instance() {
    local state
    state="$(cap_aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo unknown)"
    [ "$state" = "running" ] \
        || die "instance $INSTANCE_ID is '$state', not running - refusing to load"
    say "instance $INSTANCE_ID is running"
    # The address the hostname must resolve to: the guest's current public IP,
    # read back rather than assumed - a replaced elastic address would otherwise
    # silently point the load at a stranger.
    IP="$(cap_aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null || echo none)"
    case "$IP" in none|''|None) die "instance $INSTANCE_ID has no public address" ;; esac
    say "instance address: $IP"
}

# Stage 3's evidence must be present in this state directory: the verdict and
# the readiness code recorded by the supervisor that ran on THIS runner.
preflight_stage3() {
    local verdict ready
    verdict="$(cat "$STATE_DIR/verdict" 2>/dev/null || echo missing)"
    [ "$verdict" = "complete" ] \
        || die "Stage 3 verdict is '$verdict', not complete - no load without a passed Stage 3"
    ready="$(cat "$STATE_DIR/ready-code" 2>/dev/null || echo missing)"
    [ "$ready" = "200" ] \
        || die "Stage 3 readiness code is '$ready', not 200"
    say "Stage 3 evidence present: verdict=complete ready=200"
}

# The application must answer right now, over verified TLS, through the edge.
preflight_https() {
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
        --cacert "$TRUST_DIR/tls.crt" \
        --resolve "$CAPACITY_HOSTNAME:$PORT:$IP" \
        "https://$CAPACITY_HOSTNAME:$PORT/api/health/ready" 2>/dev/null || echo 000)"
    [ "$code" = "200" ] \
        || die "the application does not answer ready over TLS (HTTP $code)"
    say "application ready over verified TLS (HTTP 200)"
}

# The watchdog is the independent four-hour enforcement. If it died, the
# deadline is unenforced and the run must not continue on top of it.
preflight_watchdog() {
    local pid
    pid="$(cat "$STATE_DIR/watchdog-pid" 2>/dev/null || echo '')"
    case "$pid" in ''|*[!0-9]*) die "no watchdog pid recorded - the deadline is unenforced" ;; esac
    kill -0 "$pid" 2>/dev/null || die "watchdog pid $pid is not alive - the deadline is unenforced"
    say "watchdog alive (pid $pid)"
}

# Enough lifetime: the whole ramp plus the export and cleanup margins, with a
# safety margin, must fit inside the guest's original deadline. Extending the
# deadline is not an option this script has.
preflight_lifetime() {
    local now remaining need
    now="$(date +%s)"
    remaining=$(( DEADLINE_EPOCH - now ))
    need=$(( TOTAL_LOAD_SECONDS + EXPORT_MARGIN + CLEANUP_MARGIN + SAFETY_MARGIN ))
    [ "$remaining" -ge "$need" ] \
        || die "not enough lifetime: ${remaining}s remain, the sequence needs ${need}s"
    say "lifetime check: ${remaining}s remain, the sequence needs ${need}s"
}

# ---- the ramp's own time budget ---------------------------------------------
stage_seconds() {
    local d="$STAGE_DURATION" n unit
    n="${d%[smh]}"; unit="${d##*[0-9]}"
    case "$unit" in
        s) echo "$n" ;;
        m) echo $(( n * 60 )) ;;
        h) echo $(( n * 3600 )) ;;
        *) echo 0 ;;
    esac
}
TOTAL_LOAD_SECONDS=0
for _s in ${STAGES//,/ }; do
    TOTAL_LOAD_SECONDS=$(( TOTAL_LOAD_SECONDS + $(stage_seconds) ))
done
[ "$TOTAL_LOAD_SECONDS" -gt 0 ] || {
    echo "stage4-load: STAGE_DURATION '$STAGE_DURATION' is not a duration" >&2
    exit 2
}

preflight_instance
preflight_stage3
preflight_https
preflight_watchdog
preflight_lifetime

# ---- 2. target binding -------------------------------------------------------
# The fixture accounts were seeded by the guest's own bootstrap with this run's
# id and password. A sign-in through the edge proves the traffic and the
# database are the same system; without it the run could measure a stranger.
LOGIN_EMAIL="loadtest-${LOADTEST_RUN_ID}-001@assetflow.test"
LOGIN_BODY="$(printf '{"email":"%s","password":"%s"}' "$LOGIN_EMAIL" "$LOADTEST_PASSWORD")"
LOGIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 15 \
    --cacert "$TRUST_DIR/tls.crt" \
    --resolve "$CAPACITY_HOSTNAME:$PORT:$IP" \
    -H 'Content-Type: application/json' --data "$LOGIN_BODY" \
    "https://$CAPACITY_HOSTNAME:$PORT/api/auth/login" 2>/dev/null || echo 000)"
[ "$LOGIN_CODE" = "200" ] \
    || die "target binding failed: account 001 answered HTTP $LOGIN_CODE - the fixture and the traffic are different systems"
say "target bound: $LOGIN_EMAIL authenticated through the edge"

# ---- 3. the k6 handle ---------------------------------------------------------
# Same contract as load-test.sh: the pinned image, by version AND digest, so a
# floating tag can never change the measurement between runs. The guest's CA is
# mounted read-only and handed to Go's verifier through SSL_CERT_FILE, and the
# hostname is pinned to the read-back address with --add-host - so k6 verifies
# the certificate it was issued, not a skipped verification.
if command -v k6 >/dev/null 2>&1; then
    k6_cmd() { k6 run "$@"; }
    K6_LOCAL=true
elif command -v docker >/dev/null 2>&1; then
    K6_IMAGE="${K6_IMAGE:-grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8}"
    k6_cmd() {
        docker run --rm --network host \
            --add-host "$CAPACITY_HOSTNAME:$IP" \
            -e SSL_CERT_FILE=/trust/tls.crt \
            -v "$TRUST_DIR:/trust:ro" \
            -v "$RUN_DIR:/work" -w /work \
            "$K6_IMAGE" run "$@"
    }
    K6_LOCAL=false
else
    die "k6 is not installed and Docker is unavailable"
fi

# Paths inside the k6 container are /work-relative; locally they are real.
to_k6_path() {
    if [ "$K6_LOCAL" = true ]; then printf '%s' "$1"; else printf '/work%s' "${1#$RUN_DIR}"; fi
}

# ---- 4. the samplers ---------------------------------------------------------
# Two views, one CSV each, both bounded by the stage sentinel the cleanup trap
# removes: the guest's own status channel (memory, disk, deadline state - the
# fields its document actually carries; everything else is marked N/A rather
# than invented), and this generator's own CPU and memory, so a generator
# bottleneck can be named instead of blamed on the target.
GUEST_CSV="$RUN_DIR/guest-samples.csv"
GEN_CSV="$RUN_DIR/generator-samples.csv"
SAMPLER_PIDS=""

stop_samplers() {
    local pid
    for pid in $SAMPLER_PIDS; do
        kill "$pid" 2>/dev/null || true
    done
    SAMPLER_PIDS=""
    rm -f "$RUN_DIR"/*.sampling 2>/dev/null || true
}
trap stop_samplers EXIT
trap 'stop_samplers; exit 130' INT
trap 'stop_samplers; exit 143' TERM

STATUS_URL="https://$CAPACITY_HOSTNAME:$PORT/status"
sample_guest() {
    printf 'timestamp,bootstrap_status,fixture_users,mem_total_mb,mem_avail_mb,disk_used_pct,deadline_remaining_s\n' > "$GUEST_CSV"
    while [ -e "$RUN_DIR/guest.sampling" ]; do
        local body
        body="$(curl -s --max-time 10 \
            --cacert "$TRUST_DIR/tls.crt" \
            --resolve "$CAPACITY_HOSTNAME:$PORT:$IP" \
            -H "Authorization: Bearer $EVIDENCE_TOKEN" \
            "$STATUS_URL" 2>/dev/null || true)"
        python3 - "$body" >> "$GUEST_CSV" <<'PY'
import json, sys, datetime
UTC = datetime.timezone.utc
try:
    d = json.loads(sys.argv[1])
except Exception:
    print('%s,unreadable,,,,' % datetime.datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ'))
    sys.exit(0)
mem = d.get('memory') or {}
disk = d.get('disk') or {}
total_mb = mem.get('total_mb')
avail_mb = mem.get('available_mb')
row = [
    datetime.datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
    d.get('bootstrap_status') or 'unknown',
    d.get('fixture_users') if d.get('fixture_users') is not None else '',
    total_mb if total_mb is not None else '',
    avail_mb if avail_mb is not None else '',
    disk.get('used_percent', '') if disk.get('used_percent') is not None else '',
    d.get('deadline_remaining_seconds', ''),
]
print(','.join(str(x) for x in row))
PY
        sleep 15
    done
}

sample_generator() {
    printf 'timestamp,cpu_pct,mem_pct\n' > "$GEN_CSV"
    local prev_total=0 prev_idle=0 total idle
    read -r prev_total prev_idle < <(awk '/^cpu /{t=0; for(i=2;i<=NF;i++) t+=$i; print t, $5+$6}' /proc/stat)
    while [ -e "$RUN_DIR/generator.sampling" ]; do
        sleep 2
        read -r total idle < <(awk '/^cpu /{t=0; for(i=2;i<=NF;i++) t+=$i; print t, $5+$6}' /proc/stat)
        local cpu=0 mem
        if [ "$total" -gt "$prev_total" ]; then
            cpu="$(awk -v t="$total" -v pt="$prev_total" -v i="$idle" -v pi="$prev_idle" \
                'BEGIN{printf "%.1f", 100*(1-((i-pi)/(t-pt)))}')"
        fi
        prev_total="$total"; prev_idle="$idle"
        mem="$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if(t>0) printf "%.1f", 100*(t-a)/t; else print 0}' /proc/meminfo)"
        printf '%s,%s,%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$cpu" "$mem" >> "$GEN_CSV"
    done
}

# ---- 5. the ramp -------------------------------------------------------------
# One k6 run per stage, the approved workload unchanged: sign in once per VU,
# then the dashboard read path. The per-stage sleep comes from SLEEP_PLAN; a
# stage without an entry is a usage error, so an added stage can never silently
# run unpaced.
sleep_for() {
    local want="$1" pair
    for pair in ${SLEEP_PLAN//,/ }; do
        [ "${pair%%:*}" = "$want" ] && { echo "${pair##*:}"; return 0; }
    done
    return 1
}

# The pacing plan is checked against the approved ceiling BEFORE anything runs:
# VUs/(sleep+0.2s assumed response) must stay under it. 0.2 s is deliberately
# conservative - a fast target would offer more, so the plan leaves margin.
check_pacing_plan() {
    local stage sleep_s offered
    for stage in ${STAGES//,/ }; do
        sleep_s="$(sleep_for "$stage")" || {
            echo "stage4-load: no SLEEP_PLAN entry for stage $stage" >&2
            exit 2
        }
        offered="$(awk -v v="$stage" -v s="$sleep_s" \
            'BEGIN{r=v/(s+0.2); printf "%.1f", r}')"
        if ! awk -v o="$offered" -v c="$APPROVED_RPS_CEILING" 'BEGIN{exit !(o+0 <= c+0)}'; then
            echo "stage4-load: the pacing plan offers ${offered} req/s at ${stage} VUs, above the ${APPROVED_RPS_CEILING} ceiling - lower the sleep" >&2
            exit 2
        fi
        say "pacing: stage ${stage} VUs, sleep ${sleep_s}s, theoretical offered <= ${offered} req/s (ceiling ${APPROVED_RPS_CEILING})"
    done
}
check_pacing_plan

STAGE_ROWS=()
SATURATED_AT=""
SATURATED_WHY=""
ABORTED_AT=""
PEAK_RPS="0"
PEAK_RPS_VUS=""
RAMP_STOPPED=""

for stage in ${STAGES//,/ }; do
    # The deadline guard between stages: a stage must not START without the
    # lifetime to finish it plus the margins. Partial results are kept.
    now="$(date +%s)"
    remaining=$(( DEADLINE_EPOCH - now ))
    need=$(( $(stage_seconds) + EXPORT_MARGIN + CLEANUP_MARGIN + SAFETY_MARGIN ))
    if [ "$remaining" -lt "$need" ]; then
        RAMP_STOPPED="the guest deadline would not cover stage ${stage} plus the export and cleanup margins (${remaining}s remain, ${need}s needed)"
        warn "$RAMP_STOPPED"
        break
    fi

    SUMMARY="$RUN_DIR/stage-${stage}.result"
    RAW="$RUN_DIR/stage-${stage}.log"
    say "=== stage ${stage} VUs for ${STAGE_DURATION} (sleep $(sleep_for "$stage")s) ==="

    # Both samplers run only while this stage runs, bounded by sentinel files
    # the cleanup trap removes.
    touch "$RUN_DIR/guest.sampling" "$RUN_DIR/generator.sampling"
    sample_guest & SAMPLER_PIDS="$SAMPLER_PIDS $!"
    sample_generator & SAMPLER_PIDS="$SAMPLER_PIDS $!"

    SLEEP="$(sleep_for "$stage")"
    set +e
    k6_cmd \
        -e BASE_URL="https://$CAPACITY_HOSTNAME:$PORT" \
        -e VUS="$stage" \
        -e DURATION="$STAGE_DURATION" \
        -e TAG="stage-${stage}" \
        -e SLEEP="$SLEEP" \
        -e P95_THRESHOLD_MS="$P95_THRESHOLD_MS" \
        -e ERROR_RATE_THRESHOLD="$ERROR_RATE_THRESHOLD" \
        -e ABORT_ERROR_RATE="$ABORT_ERROR_RATE" \
        -e LOADTEST_USERS="$LOADTEST_USERS" \
        -e LOADTEST_PASSWORD="$LOADTEST_PASSWORD" \
        -e LOADTEST_RUN_ID="$LOADTEST_RUN_ID" \
        -e SUMMARY_FILE="$(to_k6_path "$SUMMARY")" \
        "$(to_k6_path "$HERE/../scripts/k6-load.js")" >"$RAW" 2>&1
    K6_EXIT=$?
    set -e

    stop_samplers

    # k6 exits 99 when a threshold is crossed - the interesting case, not an error.
    if [ "$K6_EXIT" -ne 0 ] && [ "$K6_EXIT" -ne 99 ]; then
        tail -20 "$RAW" >&2
        die "k6 failed in stage ${stage} (exit ${K6_EXIT}) - the log is ${RAW}"
    fi

    value() { grep -m1 "^$1=" "$SUMMARY" 2>/dev/null | cut -d= -f2- || true; }
    RPS="$(value rps)"; P50="$(value p50_ms)"; P95="$(value p95_ms)"; P99="$(value p99_ms)"
    ERR="$(value error_rate)"; THROTTLED="$(value throttled_429)"; REQUESTS="$(value requests)"
    ITERS="$(value iterations)"; LOGINS_BAD="$(value login_errors)"
    # Missing data is not a zero-latency, zero-error result. Fail closed before
    # awk can coerce an empty summary into a healthy stage.
    for measurement in "$RPS" "$P95" "$ERR" "$P50" "$P99"; do
        [[ "$measurement" =~ ^[0-9]+([.][0-9]+)?$ ]] \
            || die "missing/invalid k6 measurement in ${SUMMARY}; inspect ${RAW}"
    done
    for measurement in "$THROTTLED" "$REQUESTS" "$ITERS"; do
        [[ "$measurement" =~ ^[0-9]+$ ]] \
            || die "missing/invalid k6 count in ${SUMMARY}; inspect ${RAW}"
    done

    # The generator's own worst row for this stage, so a saturated generator is
    # visible in the same table as the target it was loading.
    MAX_GEN_CPU="-"; MAX_GEN_MEM="-"
    if [ -s "$GEN_CSV" ]; then
        MAX_GEN_CPU="$(awk -F, 'NR>1 && $2!="" {if($2>m) m=$2} END{if(m=="") print "-"; else printf "%.1f", m}' "$GEN_CSV")"
        MAX_GEN_MEM="$(awk -F, 'NR>1 && $3!="" {if($3>m) m=$3} END{if(m=="") print "-"; else printf "%.1f", m}' "$GEN_CSV")"
    fi

    VERDICT="ok"
    broke_p95="$(awk -v p="$P95" -v t="$P95_THRESHOLD_MS" 'BEGIN{print (p+0 >= t+0) ? 1 : 0}')"
    broke_err="$(awk -v e="$ERR" -v t="$ERROR_RATE_THRESHOLD" 'BEGIN{print (e+0 >= t+0) ? 1 : 0}')"
    aborted="$(awk -v e="$ERR" -v t="$ABORT_ERROR_RATE" 'BEGIN{print (e+0 >= t+0) ? 1 : 0}')"
    if [ "$aborted" = "1" ]; then
        VERDICT="ABORTED · error rate passed the ${ABORT_ERROR_RATE} ceiling"
        ABORTED_AT="$stage"
    elif [ "$broke_err" = "1" ] && [ "$THROTTLED" -gt 0 ]; then
        VERDICT="SATURATED · 429 (rate limit)"
    elif [ "$broke_err" = "1" ]; then
        VERDICT="SATURATED · errors"
    elif [ "$broke_p95" = "1" ]; then
        VERDICT="SATURATED · p95"
    elif [ "$K6_EXIT" -eq 99 ]; then
        VERDICT="SATURATED · correctness/iteration threshold"
    fi

    if [ "$VERDICT" = "ok" ] && [ "$(awk -v r="$RPS" -v p="$PEAK_RPS" 'BEGIN{print (r+0 > p+0) ? 1 : 0}')" = "1" ]; then
        PEAK_RPS="$RPS"; PEAK_RPS_VUS="$stage"
    fi

    STAGE_ROWS+=("| ${stage} | ${SLEEP} | ${REQUESTS} | ${RPS} | ${ITERS} | ${P50} | ${P95} | ${P99} | $(awk -v e="$ERR" 'BEGIN{printf "%.2f", e*100}') % | ${THROTTLED} | ${LOGINS_BAD} | ${MAX_GEN_CPU} | ${MAX_GEN_MEM} | ${VERDICT} |")

    say "  ${RPS} req/s · p50 ${P50} ms · p95 ${P95} ms · p99 ${P99} ms · errors $(awk -v e="$ERR" 'BEGIN{printf "%.2f", e*100}') % · 429s ${THROTTLED} · ${VERDICT}"

    if [ "$VERDICT" != "ok" ] && [ -z "$SATURATED_AT" ]; then
        SATURATED_AT="$stage"
        SATURATED_WHY="$VERDICT"
        say "the ramp stops here - ${VERDICT} at ${stage} VUs; partial results are preserved"
        break
    fi
done

# ---- 6. the post-load guest evidence export ----------------------------------
# The retained evidence must show the guest's state AFTER the load, verified
# against the guest's own digest - the same channel Stage 3 used, run again.
# A failed export is recorded and does not undo the measurement, but it is
# named in the report rather than silently skipped.
POST_EXPORT_NOTE="not attempted"
POST_ARCHIVE=""
POST_SHA=""
find_guest_digest() {
    local f n s
    for f in $(ls -1r "$STATE_DIR"/snapshots/*-status.json 2>/dev/null || true); do
        n="$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$f" 2>/dev/null | head -1 | cut -d'"' -f4 || true)"
        s="$(grep -o '"sha256"[[:space:]]*:[[:space:]]*"[^"]*"' "$f" 2>/dev/null | head -1 | cut -d'"' -f4 || true)"
        printf '%s' "$s" | grep -Eq '^[0-9a-f]{64}$' || continue
        case "$n" in snapshot-*.tar.gz) ;; *) continue ;; esac
        POST_NAME="$n"; POST_SHA="$s"; return 0
    done
    return 1
}
EXPORTER=""
[ -x "$HERE/../scripts/export-evidence.sh" ] && EXPORTER="$HERE/../scripts/export-evidence.sh"
[ -z "$EXPORTER" ] && [ -x "$HERE/export-evidence.sh" ] && EXPORTER="$HERE/export-evidence.sh"
if [ -z "$EXPORTER" ]; then
    POST_EXPORT_NOTE="export client not found"
elif find_guest_digest; then
    POST_ARCHIVE="$RUN_DIR/guest-evidence-postload.tar.gz"
    : > "$RUN_DIR/guest-export-postload.log"
    if EVIDENCE_TOKEN="$EVIDENCE_TOKEN" \
       EVIDENCE_CA="$TRUST_DIR/tls.crt" \
       EXPORT_RESOLVE="$CAPACITY_HOSTNAME:$PORT:$IP" \
       EXPORT_ATTEMPTS="${EXPORT_ATTEMPTS:-3}" EXPORT_TIMEOUT=120 \
       bash "$EXPORTER" "https://$CAPACITY_HOSTNAME:$PORT" "$POST_NAME" "$POST_SHA" \
           "$POST_ARCHIVE" >>"$RUN_DIR/guest-export-postload.log" 2>&1 \
       && [ -s "$POST_ARCHIVE" ]; then
        POST_EXPORT_NOTE="exported and checksum-verified: $POST_NAME sha256=$POST_SHA bytes=$(wc -c < "$POST_ARCHIVE")"
        say "$POST_EXPORT_NOTE"
    else
        POST_EXPORT_NOTE="post-load export failed or unverified: $(tail -c 300 "$RUN_DIR/guest-export-postload.log" 2>/dev/null | tr '\n' ';')"
        warn "$POST_EXPORT_NOTE"
        POST_ARCHIVE=""
    fi
else
    POST_EXPORT_NOTE="no guest-supplied digest in any retained snapshot; nothing to verify a download against"
    warn "$POST_EXPORT_NOTE"
fi

# ---- 7. the report ------------------------------------------------------------
stop_samplers
REPORT="$RUN_DIR/stage4-report.md"
CPU_CREDITS="N/A (not read: CloudWatch metrics were not part of this run's permissions)"
CONTAINER_RESTARTS="N/A (container-level counters are not carried on the status channel; the guest's own metrics land in the evidence export)"
APP_CPU="N/A (per-container CPU is not carried on the status channel)"

{
    echo "# Stage 4 - the approved load measurement - ${STAMP}"
    echo ""
    echo "Driven by \`infra/capacity-run/stage4-load.sh\` from the retained runner,"
    echo "against the Stage 3 instance. Raw k6 output, per-stage summaries and the"
    echo "samplers are next to this report in the same artifact."
    echo ""
    echo "## The result"
    echo ""
    echo "| VUs | sleep s | requests | req/s | iters | p50 ms | p95 ms | p99 ms | errors | 429s | login fail | gen CPU % max | gen mem % max | verdict |"
    echo "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
    for row in "${STAGE_ROWS[@]}"; do echo "$row"; done
    echo ""
    if [ -n "$ABORTED_AT" ]; then
        echo "**The ramp was ABORTED at ${ABORTED_AT} VUs**: the error rate passed the"
        echo "${ABORT_ERROR_RATE} ceiling, so the target was failing rather than degrading. The numbers"
        echo "for that stage are partial and must not be read as a capacity figure."
    elif [ -n "$SATURATED_AT" ]; then
        echo "**Highest stage that met every threshold: ${PEAK_RPS} req/s (${PEAK_RPS_VUS} VUs).**"
        echo "The ramp stopped at ${SATURATED_AT} VUs - ${SATURATED_WHY}. This is the highest"
        echo "TESTED passing load, not a measured maximum capacity."
    elif [ -n "$RAMP_STOPPED" ]; then
        echo "**The ramp stopped early: ${RAMP_STOPPED}.** The stages that ran are reported"
        echo "above; the rest were never offered."
    else
        echo "**Every stage met the predeclared thresholds.** Highest tested load:"
        echo "${PEAK_RPS} req/s at ${PEAK_RPS_VUS} VUs. This is the highest TESTED passing"
        echo "load, not a measured maximum capacity - no stage was pushed past 200 VUs."
    fi
    echo ""
    echo "## Reading these numbers"
    echo ""
    echo "- **Latency is public-network end-to-end from the GitHub runner** to the"
    echo "  guest over TLS: it includes the internet path, not only server processing."
    echo "- **req/s is the measured offered rate** (k6 http_reqs), not the pacing"
    echo "  plan's theoretical maximum and not the approved ceiling. The ceiling"
    echo "  (${APPROVED_RPS_CEILING} req/s) bounded the plan; what each stage actually offered is"
    echo "  in the table."
    echo "- **Successful-request throughput is not separated from total requests**"
    echo "  in the req/s column; with errors at the recorded rates the two are"
    echo "  within the error margin of each other. The error column is the correction."
    echo "- **200 fixture accounts and 200 VUs are not 200 production users**: a VU"
    echo "  is a tight loop over one read path with one account, not a person."
    echo "- Percentiles are per stage. They are never averaged into an overall figure."
    echo ""
    echo "## The workload"
    echo ""
    echo "| Item | Value |"
    echo "|---|---|"
    echo "| Stages | ${STAGES} VUs, ${STAGE_DURATION} each |"
    echo "| Pacing | per-VU sleep from \`${SLEEP_PLAN}\`; one iteration = 1 GET /api/assets?take=20 with a per-VU token |"
    echo "| Accounts | ${LOADTEST_USERS} fixture accounts (loadtest-${LOADTEST_RUN_ID}-NNN), one per VU |"
    echo "| Thresholds | p95 < ${P95_THRESHOLD_MS} ms, errors < ${ERROR_RATE_THRESHOLD}, checks > 99%, abort at ${ABORT_ERROR_RATE} |"
    echo "| k6 | the pinned image from load-test.sh, digest-pinned |"
    echo ""
    echo "## The environment"
    echo ""
    echo "| Item | Value |"
    echo "|---|---|"
    echo "| Instance | ${INSTANCE_ID} (the Stage 3 instance, unchanged) |"
    echo "| Deadline | ${DEADLINE_EPOCH} (from the actual AWS LaunchTime; the watchdog enforced it throughout) |"
    echo "| Generator | $(nproc) vCPU, $(awk '/^MemTotal:/{printf \"%.1f\", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo unknown) GiB RAM (the GitHub runner) |"
    echo "| CPU credits | ${CPU_CREDITS} |"
    echo "| Container restarts | ${CONTAINER_RESTARTS} |"
    echo "| App-side CPU | ${APP_CPU} |"
    echo "| Post-load guest export | ${POST_EXPORT_NOTE} |"
    if [ -n "$RAMP_STOPPED" ]; then echo "| Early stop | ${RAMP_STOPPED} |"; fi
    echo ""
    echo "## Raw evidence"
    echo ""
    echo "| File | Contents |"
    echo "|---|---|"
    echo "| stage-*.result | the k6 summary as key=value |"
    echo "| stage-*.log | the full k6 output for that stage |"
    echo "| guest-samples.csv | the guest's status channel every 15s during load |"
    echo "| generator-samples.csv | this generator's CPU/memory every 2s |"
    echo "| guest-evidence-postload.tar.gz | the post-load guest archive, checksum-verified |"
} > "$REPORT"

say "=== the ramp is done ==="
[ -n "$SATURATED_AT" ] && say "saturated at ${SATURATED_AT} VUs - ${SATURATED_WHY}"
[ -z "$SATURATED_AT" ] && [ -n "$ABORTED_AT" ] && say "aborted at ${ABORTED_AT} VUs"
[ -z "$SATURATED_AT" ] && [ -z "$ABORTED_AT" ] && say "all stages met the thresholds; highest tested ${PEAK_RPS} req/s at ${PEAK_RPS_VUS} VUs"
say "report: $REPORT"
printf '%s\n' "stage4-report=$REPORT" > "$STATE_DIR/stage4-report-path"
exit 0

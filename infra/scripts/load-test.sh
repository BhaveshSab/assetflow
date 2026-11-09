#!/usr/bin/env bash
#
# The saturation test: how far the stack goes before it bends, and why.
#
#   ./load-test.sh                          # 5 → 200 VUs, stops at the first wall
#   ./load-test.sh --single-user            # the "one client" comparison run
#   ./load-test.sh --stages 10,25 --stage-duration 60s
#
# It walks a ramp (one k6 run per stage), samples the host once a second while
# each stage runs, and writes a report to docs/results/load-test-<timestamp>.md.
#
# The part that makes the number explainable is the sampling: "it got slower"
# is an observation, "p95 crossed 1 s while the API container sat at 98 % of
# its CPU quota" is a diagnosis. The CSV next to the report has the raw rows.
#
# Stop conditions:
#   * a stage that breaks the thresholds is marked SATURATED and ends the ramp
#     (--keep-going continues anyway);
#   * a stage that breaks nothing means the ramp was too shallow — add stages.
#
# A SATURATED stage is a **successful** run: finding the wall is the point. The
# exit code is non-zero only for a setup problem (no API, no k6, bad arguments).
#
# Usage:
#   ./load-test.sh [--stages LIST] [--stage-duration TIME] [--keep-going]
#                  [--single-user] [--users N] [--assets N] [--no-sample]
#                  [--cleanup] [--dry-run] [--help]
#
# Environment:
#   BASE_URL             the API origin, no /api (default http://localhost:8080,
#                        which is the local override's published port).
#                        Point it at a disposable or staging stack. Production
#                        origins are refused unless ALLOW_PRODUCTION_LOAD_TEST=yes
#                        is set explicitly, because this run is designed to bend
#                        the stack it targets.
#   P95_THRESHOLD_MS     the p95 that counts as "bending" (default 1000)
#   ERROR_RATE_THRESHOLD the error rate that counts as "bending" (default 0.01)
#   SLEEP                seconds between requests per VU (default 1)
#   K6_INSECURE          true for a self-signed certificate
#
# Exit codes: 0 = the ramp ran (broken or not), 1 = setup error, 2 = usage error
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

BASE_URL="${BASE_URL:-http://localhost:8080}"
STAGES="${STAGES:-5,10,25,50,100,200}"
STAGE_DURATION="${STAGE_DURATION:-2m}"
P95_THRESHOLD_MS="${P95_THRESHOLD_MS:-1000}"
ERROR_RATE_THRESHOLD="${ERROR_RATE_THRESHOLD:-0.01}"
# The abort ceiling: above this failure rate the target is failing, not bending.
ABORT_ERROR_RATE="${ABORT_ERROR_RATE:-0.5}"
# Set when the abort ceiling stops the ramp, so the report can say where.
ABORTED_AT=""
SLEEP="${SLEEP:-1}"
LOADTEST_USERS="${LOADTEST_USERS:-30}"
LOADTEST_ASSETS="${LOADTEST_ASSETS:-0}"

KEEP_GOING=false
SINGLE_USER=false
SAMPLE=true
CLEANUP=false

while [ $# -gt 0 ]; do
    case "$1" in
        --stages) STAGES="$2"; shift ;;
        --stage-duration) STAGE_DURATION="$2"; shift ;;
        --users) LOADTEST_USERS="$2"; shift ;;
        --assets) LOADTEST_ASSETS="$2"; shift ;;
        --keep-going) KEEP_GOING=true ;;
        --single-user) SINGLE_USER=true ;;
        --no-sample) SAMPLE=false ;;
        --cleanup) CLEANUP=true ;;
        --dry-run|--help|-h) : ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
    shift
done

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
RESULTS_DIR="${REPO_ROOT}/docs/results"
RUN_DIR="${RESULTS_DIR}/load-test-${STAMP}"
REPORT="${RESULTS_DIR}/load-test-${STAMP}.md"
PG_USER="${POSTGRES_USER:-assetflow}"
PG_DB="${POSTGRES_DB:-assetflow}"
PG_PASSWORD="${POSTGRES_PASSWORD:-}"

# `--single-user` is the "before" column: every VU on one account, which is
# what the old run effectively did.
if [ "$SINGLE_USER" = true ]; then
    SAY_MODE="one account (reproduces the single-client ceiling)"
else
    SAY_MODE="${LOADTEST_USERS} accounts (one budget per virtual user)"
fi

# A denylist alone cannot establish isolation. Validate syntax before printing
# any origin (userinfo could contain credentials); actual execution is gated below.
command -v python3 >/dev/null 2>&1 || die "python3 is required for origin validation"
BASE_URL="$(python3 "${INFRA_DIR}/scripts/lib/validate-load-origin.py" "$BASE_URL")" \
    || die "invalid BASE_URL"

# ----------------------------------------------------- production guard --
# This script exists to find the point where the stack bends. Pointing it at the
# live deployment would create an outage to measure one, so production origins
# are refused unless the operator names that intent explicitly. Staging and
# disposable stacks are unaffected.
#
# This runs BEFORE the banner and BEFORE the --dry-run branch: a dry run that
# prints a plan against the production host is still a mistake being rehearsed,
# and the guard previously sat below both, so `--dry-run` exited 0 against
# production and the operator learned nothing.
#
# Matching is case-insensitive and covers every name the instance answers to.
# A string compare against two literals missed `HTTPS://13.55.90.25.sslip.IO`
# and the EC2 public DNS, so a dotted/uppercase spelling of production passed.
PRODUCTION_HOSTS="13.55.90.25 13.55.90.25.sslip.io ec2-13-55-90-25.ap-southeast-2.compute.amazonaws.com"
# Any origin under these suffixes is production too (a subdomain or a CNAME).
PRODUCTION_SUFFIXES=".sslip.io"
load_host="${BASE_URL#*://}"
load_host="${load_host%%/*}"
load_host="${load_host%%:*}"
# Strip a trailing dot (fully-qualified form) and compare lower-cased.
load_host="${load_host%.}"
load_host="$(printf '%s' "$load_host" | tr '[:upper:]' '[:lower:]')"
load_is_production=false
for production_host in $PRODUCTION_HOSTS; do
    if [ "$load_host" = "$production_host" ]; then load_is_production=true; break; fi
done
for production_suffix in $PRODUCTION_SUFFIXES; do
    case "$load_host" in *"$production_suffix") load_is_production=true; break ;; esac
done
# An EC2 public DNS name of this instance, in any region, is production.
case "$load_host" in ec2-13-55-90-25.*.compute.amazonaws.com) load_is_production=true ;; esac
if [ "$load_is_production" = true ] && [ "${ALLOW_PRODUCTION_LOAD_TEST:-no}" != yes ]; then
    die "${BASE_URL} resolves to the production deployment. A saturation run must not target it; use a staging or disposable stack, or set ALLOW_PRODUCTION_LOAD_TEST=yes if that is genuinely intended."
fi

# STAGES and its siblings are positional arguments in this script; the banner
# below is the first thing that reads them. Under `set -u` an invocation without
# an explicit --stages/STAGES assignment aborted with "STAGES: unbound variable"
# before the guard could ever be reached.
STAGES="${STAGES:-5,10,25,50,100,200}"

say "=== AssetFlow saturation test ==="
say "target:     ${BASE_URL}"
say "stages:     ${STAGES} (${STAGE_DURATION} each)"
say "identities: ${SAY_MODE}"
say "thresholds: p95 < ${P95_THRESHOLD_MS} ms, errors < ${ERROR_RATE_THRESHOLD}"
say "report:     ${REPORT}"

# ------------------------------------------------------------------ dry-run --
if [ "$DRY_RUN" = true ]; then
    say ""
    say "[dry-run] preflight: curl -fsS ${BASE_URL}/api/health"
    say "[dry-run] seed:      docker compose ... run --rm -e LOADTEST_PASSWORD=*** migrate npm run seed:loadtest -- --users ${LOADTEST_USERS} --assets ${LOADTEST_ASSETS}"
    for stage in ${STAGES//,/ }; do
        say "[dry-run] stage ${stage}: k6 run -e VUS=${stage} -e DURATION=${STAGE_DURATION} -e TAG=stage-${stage} infra/scripts/k6-load.js"
    done
    say "[dry-run] sample:    every second → ${RUN_DIR}/samples-stage-N.csv"
    say "[dry-run] report:    ${REPORT}"
    say "[dry-run] nothing was changed"
    exit 0
fi

# Fail closed. Run-owned fixtures, target binding, abort and failure-safe cleanup
# are now implemented and covered by the loadtest-isolation integration job, but
# the gate stays ON until that evidence has been reviewed. No environment
# override is sufficient approval. Remove this gate only in a reviewed follow-up.
die "load execution disabled: run-owned fixtures and target binding are implemented and under review; --dry-run remains available"

# ---------------------------------------------------------------- preflight --
say "+ preflight"
if ! curl -fsS -m 10 "${BASE_URL}/api/health" >/dev/null 2>&1; then
    if [ "${K6_INSECURE:-false}" = true ]; then
        curl -fksS -m 10 "${BASE_URL}/api/health" >/dev/null \
            || die "the API does not answer at ${BASE_URL}/api/health"
    else
        die "the API does not answer at ${BASE_URL}/api/health — is the stack up?"
    fi
fi
say "  the API answers"

if [ "$SAMPLE" = true ]; then
    command -v docker >/dev/null 2>&1 \
        || die "docker is required for the host sampling (use --no-sample when running the test from another machine)"
    compose ps --services --status running 2>/dev/null | grep -qx api \
        || die "the api container is not running here — use --no-sample when testing a remote host"
    say "  api, postgres and redis are running"
fi

if command -v k6 >/dev/null 2>&1; then
    K6=(k6)
    K6_LOCAL=true
elif command -v docker >/dev/null 2>&1; then
    say "  k6 is not installed — using the grafana/k6:2.3.0 container"
    # Pinned by version AND digest: a floating `grafana/k6` silently changes
    # the measurement between runs, and a broken or replaced `latest` would
    # arrive unannounced in a capacity report. The digest is the multi-arch
    # index published 2026-10-24. Bump deliberately, with the report.
    # --user keeps every generated file owned by the invoking user instead of
    # root, which otherwise leaves docs/results/ unwritable for the next run.
    K6=(docker run --rm --network host --user "$(id -u):$(id -g)" -v "${REPO_ROOT}:/work" -w /work \
        "${K6_IMAGE:-grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8}")
    K6_LOCAL=false
else
    die "k6 is not installed and Docker is unavailable (https://k6.io/docs/get-started/installation/)"
fi

# Inside the container the repository is mounted at /work, so a host absolute
# path is invisible there. Every path handed to k6 has to be translated; without
# this the summary was written to a path k6 could not create and the script then
# reported "missing/invalid k6 measurement" — or, worse, an empty summary that
# looked like a healthy stage.
to_k6_path() {
    if [ "$K6_LOCAL" = true ]; then
        printf '%s' "$1"
    else
        printf '/work%s' "${1#"$REPO_ROOT"}"
    fi
}

K6_TLS=()
if [ "${K6_INSECURE:-false}" = true ]; then
    K6_TLS=(--insecure-skip-tls-verify)
fi

mkdir -p "$RUN_DIR"

# --------------------------------------------------------------- cleanup ----
# A run-owned sampler must not outlive the run. Without this, Ctrl-C (or a
# failing stage) leaves `sample_csv` writing into docs/results/ forever, on a
# host that may only have a few hundred MiB free. Installed BEFORE any fixture
# or sampler is created, and it preserves the original exit status while still
# reporting its own failures.
SAMPLER_PID=""
CLEANUP_DONE=false
cleanup() {
    local status=$?
    if [ "$CLEANUP_DONE" = true ]; then return "$status"; fi
    CLEANUP_DONE=true
    if [ -n "$SAMPLER_PID" ]; then
        if kill -0 "$SAMPLER_PID" 2>/dev/null; then
            kill "$SAMPLER_PID" 2>/dev/null || true
            wait "$SAMPLER_PID" 2>/dev/null || true
        fi
    fi
    # The sentinel file is the sampler's own stop condition; remove it here so
    # a later run cannot inherit a stale sampler from this one.
    for sentinel in "${RUN_DIR}"/samples-stage-*.csv.running; do
        [ -e "$sentinel" ] || continue
        rm -f "$sentinel" 2>/dev/null || warn "could not remove ${sentinel}"
    done
    return "$status"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# The accounts exist only for this run: the password is generated here, used by
# the seed and by k6, and never written down.
#
# The read must be bounded. `base64 </dev/urandom` reads an endless stream: when
# the consumer stops, the writer keeps producing until it is killed, so the
# assignment could spin a CPU indefinitely on a small host instead of returning
# a password. 64 random bytes are plenty for 40 alphanumerics.
new_loadtest_password() {
    head -c 64 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-40
}

LOADTEST_PASSWORD="$(new_loadtest_password)"
if [ "${#LOADTEST_PASSWORD}" -ne 40 ]; then
    die "could not generate a load-test password (got ${#LOADTEST_PASSWORD} characters)"
fi

# ------------------------------------------------------------ run ownership --
# Every row this run creates is named after it, so a concurrent run can neither
# overwrite this run's accounts nor delete them when it cleans up.
LOADTEST_RUN_ID="${LOADTEST_RUN_ID:-$(date -u +%Y%m%dt%H%M%sz)-$(new_loadtest_password | cut -c1-8 | tr '[:upper:]' '[:lower:]')}"
case "$LOADTEST_RUN_ID" in
    [a-z0-9]*) ;;
    *) die "LOADTEST_RUN_ID must start with a lowercase letter or digit" ;;
esac
say "run id:     ${LOADTEST_RUN_ID}"

# Cleanup is registered before anything is created, so an interrupt, a failed
# stage or a failed seed all leave the database as it was found.
CLEANUP_REQUIRED=false
load_cleanup() {
    local status=$?
    if [ "$CLEANUP_REQUIRED" = true ]; then
        say "+ removing this run's fixture (${LOADTEST_RUN_ID})"
        compose run --rm -T \
            -e LOADTEST_RUN_ID="$LOADTEST_RUN_ID" \
            migrate npm run seed:loadtest -- --run-id "$LOADTEST_RUN_ID" --delete \
            >&2 || warn "fixture cleanup failed — remove run ${LOADTEST_RUN_ID} by hand"
    fi
    return "$status"
}
trap load_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "+ seeding the fixture (${LOADTEST_USERS} accounts, ${LOADTEST_ASSETS} assets)"
CLEANUP_REQUIRED=true
compose run --rm -T \
    -e LOADTEST_PASSWORD="$LOADTEST_PASSWORD" \
    -e LOADTEST_RUN_ID="$LOADTEST_RUN_ID" \
    migrate npm run seed:loadtest -- \
        --run-id "$LOADTEST_RUN_ID" --users "$LOADTEST_USERS" --assets "$LOADTEST_ASSETS" \
    >&2
say "  fixture ready"

# ------------------------------------------------------------ target binding --
# The fixture is written through local Compose; the traffic goes to BASE_URL.
# Those were independent, so a run could seed one database and measure another —
# every request a 401, and the report would blame the stack. The binding proof
# is a sign-in: only the database the fixture lives in can authenticate a
# run-owned account whose password was generated seconds ago.
#
# This runs for every run, including single-user mode, because it is a
# correctness check about *which* system is being measured, not about identity.
LOGIN_EMAIL="loadtest-${LOADTEST_RUN_ID}-001@assetflow.test"
LOGIN_BODY="$(printf '{"email":"%s","password":"%s"}' "$LOGIN_EMAIL" "$LOADTEST_PASSWORD")"
LOGIN_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 \
    -H 'Content-Type: application/json' --data "$LOGIN_BODY" \
    "${BASE_URL}/api/auth/login" || true)"
if [ "$LOGIN_CODE" != "200" ]; then
    say "  fixture account ${LOGIN_EMAIL} -> HTTP ${LOGIN_CODE}" >&2
    die "target binding failed: ${BASE_URL} cannot sign in as this run's fixture account. The seeder writes to the local Compose database, so a mismatch means the traffic would hit a different system than the one holding the fixture. Point BASE_URL at that same stack."
fi
say "  target bound: ${BASE_URL} authenticated this run's fixture account"

# ------------------------------------------------------------------ sampler --
# One row per second: the host, the two containers and Postgres itself. This is
# what turns a slow stage into a named bottleneck.
sample_csv() {
    local out="$1"
    local api_id pg_id
    api_id="$(compose ps -q api 2>/dev/null || true)"
    pg_id="$(compose ps -q postgres 2>/dev/null || true)"

    printf 'timestamp,host_cpu_pct,host_mem_pct,api_cpu_pct,api_mem_pct,pg_connections,pg_locks_waiting\n' >"$out"

    local prev_total=0 prev_idle=0 total idle
    read -r prev_total prev_idle < <(awk '/^cpu /{t=0; for(i=2;i<=NF;i++) t+=$i; print t, $5+$6}' /proc/stat)

    while [ -f "${out}.running" ]; do
        sleep 1
        read -r total idle < <(awk '/^cpu /{t=0; for(i=2;i<=NF;i++) t+=$i; print t, $5+$6}' /proc/stat)
        local cpu=0 mem
        if [ "$total" -gt "$prev_total" ]; then
            cpu="$(awk -v t="$total" -v pt="$prev_total" -v i="$idle" -v pi="$prev_idle" \
                'BEGIN{printf "%.1f", 100*(1-((i-pi)/(t-pt)))}')"
        fi
        prev_total="$total"; prev_idle="$idle"
        mem="$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if(t>0) printf "%.1f", 100*(t-a)/t; else print 0}' /proc/meminfo)"

        local api_cpu="" api_mem="" name cpup memp
        local -a targets=()
        [ -n "$api_id" ] && targets+=("$api_id")
        [ -n "$pg_id" ] && targets+=("$pg_id")
        while IFS=, read -r name cpup memp; do
            [ -n "$name" ] || continue
            case "$name" in
                *-api-*) api_cpu="${cpup%\%}"; api_mem="${memp%\%}" ;;
            esac
        done < <(docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemPerc}}' \
            "${targets[@]}" 2>/dev/null || true)

        local pg="" conns="" locks=""
        pg="$(compose exec -T -e PGPASSWORD="$PG_PASSWORD" postgres \
            psql -U "$PG_USER" -d "$PG_DB" -tAc \
            "select count(*) || '|' || count(*) filter (where wait_event_type = 'Lock') from pg_stat_activity where datname = current_database()" \
            2>/dev/null | tr -d '[:space:]' || true)"
        if [ -n "$pg" ]; then
            conns="${pg%%|*}"; locks="${pg##*|}"
        fi

        printf '%s,%s,%s,%s,%s,%s,%s\n' \
            "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$cpu" "$mem" "${api_cpu:-}" "${api_mem:-}" "${conns:-}" "${locks:-}" \
            >>"$out"
    done
}

# --------------------------------------------------------------- the ramp ----
SATURATED_AT=""
SATURATED_WHY=""
PEAK_RPS="0"
PEAK_RPS_VUS=""
STAGE_ROWS=()

IFS=',' read -r -a STAGE_LIST <<<"$STAGES"

for stage in "${STAGE_LIST[@]}"; do
    stage="${stage// /}"
    [ -n "$stage" ] || continue

    SUMMARY="${RUN_DIR}/stage-${stage}.result"
    RAW="${RUN_DIR}/stage-${stage}.log"
    CSV="${RUN_DIR}/samples-stage-${stage}.csv"

    say ""
    say "=== stage ${stage} VUs for ${STAGE_DURATION} ==="

    if [ "$SAMPLE" = true ]; then
        touch "${CSV}.running"
        sample_csv "$CSV" &
        SAMPLER_PID=$!
    fi

    set +e
    "${K6[@]}" run "${K6_TLS[@]}" \
        -e BASE_URL="$BASE_URL" \
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
        -e SINGLE_USER="$SINGLE_USER" \
        -e SUMMARY_FILE="$(to_k6_path "$SUMMARY")" \
        "$(to_k6_path "${REPO_ROOT}/infra/scripts/k6-load.js")" >"$RAW" 2>&1
    K6_EXIT=$?
    set -e

    if [ "$SAMPLE" = true ]; then
        rm -f "${CSV}.running"
        wait "$SAMPLER_PID" 2>/dev/null || true
    fi

    # k6 exits 99 when a threshold is crossed — the interesting case, not an error.
    if [ "$K6_EXIT" -ne 0 ] && [ "$K6_EXIT" -ne 99 ]; then
        tail -20 "$RAW" >&2
        die "k6 failed in stage ${stage} (exit ${K6_EXIT}) — the log is ${RAW}"
    fi

    value() { grep -m1 "^$1=" "$SUMMARY" 2>/dev/null | cut -d= -f2- || true; }
    RPS="$(value rps)"; P95="$(value p95_ms)"; ERR="$(value error_rate)"
    THROTTLED="$(value throttled_429)"; REQUESTS="$(value requests)"
    # Missing data is not a zero-latency, zero-error result. Fail closed before
    # awk can coerce NA (or an empty summary) to zero and label a stage healthy.
    for measurement in "$RPS" "$P95" "$ERR"; do
        [[ "$measurement" =~ ^[0-9]+([.][0-9]+)?$ ]] \
            || die "missing/invalid k6 measurement in ${SUMMARY}; inspect ${RAW}"
    done
    for measurement in "$THROTTLED" "$REQUESTS"; do
        [[ "$measurement" =~ ^[0-9]+$ ]] \
            || die "missing/invalid k6 count in ${SUMMARY}; inspect ${RAW}"
    done

    # The sampler's worst row for this stage.
    MAX_CPU="-"; MAX_API="-"; MAX_CONNS="-"; MAX_LOCKS="-"
    if [ -s "$CSV" ]; then
        MAX_CPU="$(awk -F, 'NR>1 && $2!="" {if($2>m) m=$2} END{if(m=="") print "-"; else printf "%.1f", m}' "$CSV")"
        MAX_API="$(awk -F, 'NR>1 && $4!="" {if($4>m) m=$4} END{if(m=="") print "-"; else printf "%.1f", m}' "$CSV")"
        MAX_CONNS="$(awk -F, 'NR>1 && $6!="" {if($6>m) m=$6} END{if(m=="") print "-"; else printf "%d", m}' "$CSV")"
        MAX_LOCKS="$(awk -F, 'NR>1 && $7!="" {if($7>m) m=$7} END{if(m=="") print "-"; else printf "%d", m}' "$CSV")"
    fi

    VERDICT="ok"
    broke_p95="$(awk -v p="$P95" -v t="$P95_THRESHOLD_MS" 'BEGIN{print (p+0 >= t+0) ? 1 : 0}')"
    broke_err="$(awk -v e="$ERR" -v t="$ERROR_RATE_THRESHOLD" 'BEGIN{print (e+0 >= t+0) ? 1 : 0}')"
    # A target failing past the abort ceiling was stopped, not measured to the end.
    # Saying ABORTED keeps that distinct from a stage that bent and completed.
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

    if [ "$VERDICT" = ok ] && [ "$(awk -v r="$RPS" -v p="$PEAK_RPS" 'BEGIN{print (r+0 > p+0) ? 1 : 0}')" = "1" ]; then
        PEAK_RPS="$RPS"; PEAK_RPS_VUS="$stage"
    fi

    STAGE_ROWS+=("| ${stage} | ${RPS} | ${P95} | $(awk -v e="$ERR" 'BEGIN{printf "%.2f", e*100}') % | ${THROTTLED} | ${MAX_CPU} | ${MAX_API} | ${MAX_CONNS} | ${MAX_LOCKS} | ${VERDICT} |")

    say "  ${RPS} req/s · p95 ${P95} ms · errors $(awk -v e="$ERR" 'BEGIN{printf "%.2f", e*100}') % · 429s ${THROTTLED} · ${VERDICT}"

    if [ "$VERDICT" != "ok" ] && [ -z "$SATURATED_AT" ]; then
        SATURATED_AT="$stage"
        SATURATED_WHY="$VERDICT"
        if [ "$KEEP_GOING" = false ]; then
            say ""
            say "the ramp stops here — ${VERDICT} at ${stage} VUs (--keep-going to continue)"
            break
        fi
    fi
done

# ----------------------------------------------------------------- the report --
DB_SIZE="$(compose exec -T -e PGPASSWORD="$PG_PASSWORD" postgres \
    psql -U "$PG_USER" -d "$PG_DB" -tAc "select pg_size_pretty(pg_database_size(current_database()))" 2>/dev/null | tr -d '[:space:]' || true)"
ASSET_COUNT="$(compose exec -T -e PGPASSWORD="$PG_PASSWORD" postgres \
    psql -U "$PG_USER" -d "$PG_DB" -tAc 'select count(*) from "Asset"' 2>/dev/null | tr -d '[:space:]' || true)"
DB_SIZE="${DB_SIZE:-unknown}"
ASSET_COUNT="${ASSET_COUNT:-unknown}"

{
    echo "# The saturation test — ${STAMP}"
    echo ""
    echo "Generated by \`infra/scripts/load-test.sh\`. Every number below was"
    echo "produced by this run; the raw k6 output and the per-second samples are"
    echo "in \`docs/results/load-test-${STAMP}/\`."
    echo ""
    echo "## The result"
    echo ""
    echo "| VUs | req/s | p95 (ms) | errors | 429s | host CPU % (max) | api CPU % (max) | PG conns (max) | PG locks (max) | verdict |"
    echo "|---|---|---|---|---|---|---|---|---|---|"
    for row in "${STAGE_ROWS[@]}"; do echo "$row"; done
    echo ""
    if [ -n "$SATURATED_AT" ]; then
        echo "**Highest healthy stage: ${PEAK_RPS} req/s (${PEAK_RPS_VUS:-none} VUs);"
        echo "saturated at ${SATURATED_AT} VUs — ${SATURATED_WHY}.**"
        if [ -n "$ABORTED_AT" ]; then
            echo ""
            echo "The ramp was **aborted** at ${ABORTED_AT} VUs, not measured to completion:"
            echo "the error rate passed the ${ABORT_ERROR_RATE} ceiling, so the target was failing"
            echo "rather than degrading. The numbers for that stage are partial and should not be"
            echo "read as a capacity figure."
        fi
    else
        echo "**No stage broke the thresholds.** The highest stage held ${PEAK_RPS} req/s;"
        echo "the ramp was too shallow to find the wall — add stages with \`--stages\`."
    fi
    echo ""
    echo "## The environment"
    echo ""
    echo "| Item | Value |"
    echo "|---|---|"
    echo "| Host | $(nproc) vCPU, $(awk '/^MemTotal:/{printf "%.1f", $2/1024/1024}' /proc/meminfo) GiB RAM |"
    echo "| Kernel / Docker | $(uname -r) / $(docker --version 2>/dev/null || echo "unknown") |"
    echo "| Target | ${BASE_URL} |"
    echo "| Mode | ${SAY_MODE} |"
    echo "| Database | ${DB_SIZE}, ${ASSET_COUNT} assets |"
    echo "| Pacing | ${SLEEP} s between requests per VU |"
    echo "| Thresholds | p95 < ${P95_THRESHOLD_MS} ms, errors < ${ERROR_RATE_THRESHOLD} |"
    echo ""
    echo "## The command"
    echo ""
    echo '```bash'
    if [ "$SINGLE_USER" = true ]; then
        echo "BASE_URL=${BASE_URL} infra/scripts/load-test.sh --single-user --stages ${STAGES} --stage-duration ${STAGE_DURATION}"
    else
        echo "BASE_URL=${BASE_URL} infra/scripts/load-test.sh --stages ${STAGES} --stage-duration ${STAGE_DURATION}"
    fi
    echo '```'
    echo ""
    echo "## Reading the table"
    echo ""
    echo "- **429s** — the API's own rate limit answered. That is the designed"
    echo "  ceiling for one client (300 requests a minute), not a capacity limit:"
    echo "  a stage that saturates here is measuring the limiter, and the fix is"
    echo "  another identity, not a bigger server."
    echo "- **api CPU % (max)** — the container is limited to 1.0 CPU, so 100 means"
    echo "  it hit its quota and requests queued for a core."
    echo "- **PG conns (max)** — the Prisma/pg pool size. If this row is pinned and"
    echo "  p95 climbs with it, the pool is the bottleneck, not the CPU."
    echo "- **PG locks (max)** — sessions waiting on a lock. Non-zero means"
    echo "  contention inside Postgres, not load on the API."
    echo ""
    echo "## Raw evidence"
    echo ""
    echo "| File | Contents |"
    echo "|---|---|"
    echo "| \`samples-stage-*.csv\` | one row per second: host and container CPU/memory, Postgres connections and lock waiters |"
    echo "| \`stage-*.result\` | the k6 summary as \`key=value\` |"
    echo "| \`stage-*.log\` | the full k6 output for that stage |"
} >"$REPORT"

say ""
say "=== the ramp is done ==="
if [ -n "$SATURATED_AT" ]; then
    say "highest healthy throughput ${PEAK_RPS} req/s at ${PEAK_RPS_VUS:-none} VUs; saturated at ${SATURATED_AT} VUs — ${SATURATED_WHY}"
else
    say "no stage broke the thresholds; the highest was ${PEAK_RPS} req/s at ${PEAK_RPS_VUS} VUs"
fi
say "report:   ${REPORT}"
say "evidence: ${RUN_DIR}/"
# The EXIT trap removes this run's fixture whether the ramp completed, was
# aborted by a threshold, or was interrupted. --cleanup is kept for
# compatibility and only says so; leaving rows behind is no longer a supported
# outcome.
if [ "$CLEANUP" = true ]; then
    say "removing this run's fixture accounts and assets"
else
    say "removing this run's fixture on exit (run ${LOADTEST_RUN_ID})"
fi

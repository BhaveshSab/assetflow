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
#   BASE_URL             the API origin, no /api (default http://localhost:8080).
#                        On the server: BASE_URL=https://3.107.83.86.sslip.io
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
elif command -v docker >/dev/null 2>&1; then
    say "  k6 is not installed — using the grafana/k6 container"
    K6=(docker run --rm --network host -v "${REPO_ROOT}:/work" -w /work grafana/k6)
else
    die "k6 is not installed and Docker is unavailable (https://k6.io/docs/get-started/installation/)"
fi

K6_TLS=()
if [ "${K6_INSECURE:-false}" = true ]; then
    K6_TLS=(--insecure-skip-tls-verify)
fi

mkdir -p "$RUN_DIR"

# The accounts exist only for this run: the password is generated here, used by
# the seed and by k6, and never written down.
LOADTEST_PASSWORD="$(base64 </dev/urandom | tr -d '/+=' | cut -c1-40)"

say "+ seeding the fixture (${LOADTEST_USERS} accounts, ${LOADTEST_ASSETS} assets)"
compose run --rm -T \
    -e LOADTEST_PASSWORD="$LOADTEST_PASSWORD" \
    migrate npm run seed:loadtest -- --users "$LOADTEST_USERS" --assets "$LOADTEST_ASSETS" \
    >&2
say "  fixture ready"

# A sign-in must work before the ramp does — otherwise every stage would just
# measure a 401.
LOGIN_EMAIL="loadtest-001@assetflow.test"
if [ "$SINGLE_USER" = false ] && [ "$LOADTEST_USERS" -gt 1 ]; then
    LOGIN_BODY="$(printf '{"email":"%s","password":"%s"}' "$LOGIN_EMAIL" "$LOADTEST_PASSWORD")"
    LOGIN_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 \
        -H 'Content-Type: application/json' --data "$LOGIN_BODY" \
        "${BASE_URL}/api/auth/login" || true)"
    [ "$LOGIN_CODE" = "200" ] \
        || die "the load-test account ${LOGIN_EMAIL} cannot sign in (HTTP ${LOGIN_CODE})"
    say "  ${LOGIN_EMAIL} signs in"
fi

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
        -e LOADTEST_USERS="$LOADTEST_USERS" \
        -e LOADTEST_PASSWORD="$LOADTEST_PASSWORD" \
        -e SINGLE_USER="$SINGLE_USER" \
        -e SUMMARY_FILE="$SUMMARY" \
        "${REPO_ROOT}/infra/scripts/k6-load.js" >"$RAW" 2>&1
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
    RPS="${RPS:-0}"; P95="${P95:-0}"; ERR="${ERR:-0}"; THROTTLED="${THROTTLED:-0}"; REQUESTS="${REQUESTS:-0}"

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
    if [ "$broke_err" = "1" ] && [ "$THROTTLED" -gt 0 ]; then
        VERDICT="SATURATED · 429 (rate limit)"
    elif [ "$broke_err" = "1" ]; then
        VERDICT="SATURATED · errors"
    elif [ "$broke_p95" = "1" ]; then
        VERDICT="SATURATED · p95"
    fi

    if [ "$(awk -v r="$RPS" -v p="$PEAK_RPS" 'BEGIN{print (r+0 > p+0) ? 1 : 0}')" = "1" ]; then
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
        echo "**Held ${PEAK_RPS} req/s at the top healthy stage (${PEAK_RPS_VUS} VUs);"
        echo "saturated at ${SATURATED_AT} VUs — ${SATURATED_WHY}.**"
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
    say "held ${PEAK_RPS} req/s at ${PEAK_RPS_VUS} VUs; saturated at ${SATURATED_AT} VUs — ${SATURATED_WHY}"
else
    say "no stage broke the thresholds; the highest was ${PEAK_RPS} req/s at ${PEAK_RPS_VUS} VUs"
fi
say "report:   ${REPORT}"
say "evidence: ${RUN_DIR}/"
if [ "$CLEANUP" = true ]; then
    say "removing the fixture accounts"
    compose run --rm -T migrate npm run seed:loadtest -- --delete >&2 || warn "the cleanup failed — remove them by hand"
else
    say "the fixture accounts stay (random password, EMPLOYEE role) — remove them with:"
    say "  docker compose -f infra/docker-compose.yml run --rm migrate npm run seed:loadtest -- --delete"
fi

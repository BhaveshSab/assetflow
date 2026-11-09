#!/usr/bin/env bash
#
# Isolated load-test fixture integration for CI.
#
# Exercises the run-owned fixture that infra/scripts/load-test.sh and
# backend/prisma/seed-loadtest.ts now implement, against real PostgreSQL 16.
#
# Why this exists: before run ownership, every run used the same fixed
# identities (`loadtest-001@assetflow.test`). Two runs at once overwrote each
# other's password, and `--delete` removed whichever rows matched - possibly
# another run's, possibly while it was still running. These cases pin the new
# contract, including the ways it must REFUSE.
#
# Nothing here touches AWS, production, or any credential. Every row is
# synthetic and every resource carries this run's prefix.
#
# Usage: integration-loadtest.sh <repo-root>
#
# Environment:
#   LOADTEST_MIGRATE_IMAGE  image tag with the seed script (default: from SHA)
#   POSTGRES_IMAGE          database image (default postgres:16.4-alpine)
#
# Results are written to test-results/loadtest-isolation.{json,txt}, outside the
# temporary work directory, so they survive cleanup.

set -uo pipefail

REPO="${1:-$(cd "$(dirname "$0")/../../.." && pwd)}"
cd "$REPO" || { echo "cannot enter ${REPO}" >&2; exit 1; }

# Lower-case: the seed script accepts only [a-z0-9-] in a run id, and a
# upper-case form would be rejected there while looking fine here.
RUN_ID="$(date -u '+%Y%m%dt%H%M%S')-$$"
PREFIX="assetflow-lt-${RUN_ID}"
PG_IMAGE="${POSTGRES_IMAGE:-postgres:16.4-alpine}"
SHA="$(git rev-parse HEAD)"
MIGRATE_IMAGE="${LOADTEST_MIGRATE_IMAGE:-assetflow-it-migrate:${SHA}}"
WORK="$(mktemp -d)"
RESULTS="${RESULTS_FILE:-${REPO}/test-results/loadtest-isolation.json}"
RESULTS_TXT="${RESULTS%.json}.txt"
mkdir -p "$(dirname "$RESULTS")"

PASS=0
FAIL=0
SKIP=0
declare -a CASES=()

CONTAINER=""
VOLUME=""
NETWORK=""
CONTAINER_CREATED=false
VOLUME_CREATED=false
NETWORK_CREATED=false
CLEANUP_DONE=false

# ---------------------------------------------------------------- reporting --
record() { # name status detail
    local name="$1" status="$2" detail="${3:-}"
    CASES+=("$(printf '%s\t%s\t%s' "$name" "$status" "$detail")")
    printf '  %-52s %-6s %s\n' "$name" "$status" "$detail"
    case "$status" in
        PASS) PASS=$((PASS + 1)) ;;
        FAIL) FAIL=$((FAIL + 1)) ;;
        SKIP) SKIP=$((SKIP + 1)) ;;
    esac
}

emit_results() {
    local status="$1"
    {
        printf '{\n  "run": "loadtest-isolation",\n  "commit": "%s",\n' "$SHA"
        printf '  "passed": %d,\n  "failed": %d,\n  "skipped": %d,\n  "overall": "%s",\n' \
            "$PASS" "$FAIL" "$SKIP" "$status"
        printf '  "cases": [\n'
        local first=true row n v d
        for row in "${CASES[@]}"; do
            IFS=$'\t' read -r n v d <<<"$row"
            d="${d//\\/\\\\}"
            d="${d//\"/\\\"}"
            [ "$first" = true ] || printf ',\n'
            first=false
            printf '    {"name": "%s", "status": "%s", "detail": "%s"}' "$n" "$v" "$d"
        done
        printf '\n  ]\n}\n'
    } >"$RESULTS"
    {
        echo "== isolated load-test fixture =="
        echo "commit: ${SHA}"
        echo "results: passed=${PASS} failed=${FAIL} skipped=${SKIP} overall=${status}"
        printf '%s\n' "${CASES[@]}" | while IFS=$'\t' read -r n v d; do echo "  ${v} ${n} ${d}"; done
    } >"$RESULTS_TXT"
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
        local row name verdict detail
        for row in "${CASES[@]}"; do
            IFS=$'\t' read -r name verdict detail <<<"$row"
            [ "$verdict" = FAIL ] || continue
            detail="${detail//'%'/'%25'}"; detail="${detail//$'\r'/'%0D'}"; detail="${detail//$'\n'/'%0A'}"
            printf '::error title=loadtest isolation: %s::%s\n' "$name" "$detail"
        done
        printf '::notice title=loadtest isolation counts::passed=%s failed=%s skipped=%s overall=%s\n' \
            "$PASS" "$FAIL" "$SKIP" "$status"
    fi
}

write_summary() {
    local status="$1"
    [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0
    {
        echo "## Isolated load-test fixture"
        echo
        echo "\`passed=${PASS} failed=${FAIL} skipped=${SKIP} overall=${status}\`"
        echo
        echo '```'
        cat "$RESULTS_TXT"
        echo '```'
    } >>"$GITHUB_STEP_SUMMARY"
}

# ---------------------------------------------------------------- lifecycle --
# shellcheck disable=SC2317  # called from cleanup
retry() {
    local attempt
    for attempt in 1 2 3 4 5; do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep "$attempt"
    done
    return 1
}

# shellcheck disable=SC2317  # invoked by the EXIT/INT/TERM traps below
cleanup() {
    local status=$?
    [ "$CLEANUP_DONE" = false ] || return "$status"
    CLEANUP_DONE=true
    if [ "$CONTAINER_CREATED" = true ]; then retry docker rm -f "$CONTAINER" || true; fi
    if [ "$VOLUME_CREATED" = true ]; then retry docker volume rm "$VOLUME" || true; fi
    if [ "$NETWORK_CREATED" = true ]; then retry docker network rm "$NETWORK" || true; fi
    rm -rf -- "$WORK"
    return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# shellcheck disable=SC2317  # exits the script; not unreachable in practice
die() { echo "FATAL: $*" >&2; emit_results FAIL; write_summary FAIL; exit 1; }

# ------------------------------------------------------------------ prelude --
echo "== isolated load-test fixture =="
echo "commit: ${SHA}"

if ! docker info >/dev/null 2>&1; then
    die "no Docker daemon available"
fi

echo "== building the fixture tooling =="
if ! docker build -f infra/docker/Dockerfile.api --target migrate \
    -t "$MIGRATE_IMAGE" . >"${WORK}/build.log" 2>&1; then
    tail -20 "${WORK}/build.log" >&2
    die "could not build the migrate image"
fi
record "build migrate image" PASS "$(basename "$MIGRATE_IMAGE")"

NETWORK="${PREFIX}-net"
VOLUME="${PREFIX}-data"
CONTAINER="${PREFIX}-db"

docker network create --internal "$NETWORK" >/dev/null || die "cannot create the network"
NETWORK_CREATED=true
docker volume create "$VOLUME" >/dev/null || die "cannot create the volume"
VOLUME_CREATED=true
docker run -d --name "$CONTAINER" \
    --network "$NETWORK" \
    -e POSTGRES_PASSWORD=it-not-a-secret \
    -e POSTGRES_DB=assetflow \
    -v "${VOLUME}:/var/lib/postgresql/data" \
    "$PG_IMAGE" >/dev/null || die "cannot start postgres"
CONTAINER_CREATED=true

run_db() { docker exec "$CONTAINER" psql -U postgres -d assetflow -v ON_ERROR_STOP=1 "$@"; }

# A real query, not pg_isready: initdb answers a temporary server on the unix
# socket before it restarts, and a loop that trusts that races the restart.
ready=false
for _ in $(seq 1 90); do
    if docker exec "$CONTAINER" psql -U postgres -d assetflow -tAc 'select 1' >/dev/null 2>&1; then
        ready=true; break
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
        break
    fi
    sleep 1
done
[ "$ready" = true ] || die "the throwaway database did not start"
record "postgres ready" PASS "$PG_IMAGE"

# The API container joins the internal network, so migrations run inside it.
MIGRATE_FLAGS=(--rm --network "$NETWORK"
    -e DATABASE_URL="postgresql://postgres:it-not-a-secret@${CONTAINER}:5432/assetflow"
    -e DATABASE_URL_UNPOOLED="postgresql://postgres:it-not-a-secret@${CONTAINER}:5432/assetflow")
migrate_run() { docker run "${MIGRATE_FLAGS[@]}" "$@"; }

if ! migrate_run "$MIGRATE_IMAGE" \
    node node_modules/prisma/build/index.js migrate deploy >"${WORK}/migrate.log" 2>&1; then
    tail -20 "${WORK}/migrate.log" >&2
    die "prisma migrate deploy failed"
fi
record "prisma migrate deploy" PASS "schema current"

# ------------------------------------------------------------------- seeding --
# A helper so every case uses the real seed script with a real run id.
seed() { # run-id extra-args...
    local rid="$1"; shift
    migrate_run -e LOADTEST_RUN_ID="$rid" -e LOADTEST_PASSWORD="it-run-password-000000000000" \
        "$MIGRATE_IMAGE" node node_modules/ts-node/dist/bin.js \
        prisma/seed-loadtest.ts --run-id "$rid" "$@"
}
count_users() { # run-id
    run_db -tAc "select count(*) from \"User\" where email like 'loadtest-$1-%@assetflow.test'"
}
count_assets() { # run-id
    run_db -tAc "select count(*) from \"Asset\" where \"assetTag\" like 'LT-$1-%'"
}

echo "== run-owned fixtures =="

RUN_A="it${RUN_ID}-a"
RUN_B="it${RUN_ID}-b"

if seed "$RUN_A" --users 3 >"${WORK}/seed-a.log" 2>&1; then
    record "seed a run's fixture" PASS "3 accounts"
else
    tail -5 "${WORK}/seed-a.log" >&2
    record "seed a run's fixture" FAIL "seed failed"
fi

# The whole point: a second run must not see, overwrite or depend on the first.
if seed "$RUN_B" --users 2 >"${WORK}/seed-b.log" 2>&1; then
    a_users="$(count_users "$RUN_A")"; b_users="$(count_users "$RUN_B")"
    if [ "$a_users" = "3" ] && [ "$b_users" = "2" ]; then
        record "two concurrent runs stay separate" PASS "a=3 b=2"
    else
        record "two concurrent runs stay separate" FAIL "a=${a_users} b=${b_users}"
    fi
else
    record "two concurrent runs stay separate" FAIL "the second seed failed"
fi

# Emails must be run-scoped, not the old shared loadtest-001@ name space.
if [ "$(run_db -tAc "select count(*) from \"User\" where email = 'loadtest-001@assetflow.test'")" = "0" ]; then
    record "no shared identities created" PASS "loadtest-001@ absent"
else
    record "no shared identities created" FAIL "a fixed identity was written"
fi

echo "== refusals =="

# Re-seeding an owned run id must refuse rather than silently adopt the rows.
if seed "$RUN_A" --users 3 >"${WORK}/reseed.log" 2>&1; then
    record "reseed of an owned run is refused" FAIL "it seeded anyway"
else
    if grep -q "already owns" "${WORK}/reseed.log"; then
        record "reseed of an owned run is refused" PASS "said why"
    else
        record "reseed of an owned run is refused" FAIL "refused without a clear reason"
    fi
fi

# A missing run id must refuse: unnamed fixtures cannot be safely cleaned up.
if migrate_run -e LOADTEST_RUN_ID= -e LOADTEST_PASSWORD=x \
    "$MIGRATE_IMAGE" node node_modules/ts-node/dist/bin.js \
    prisma/seed-loadtest.ts --users 2 >"${WORK}/no-runid.log" 2>&1; then
    record "seed without a run id is refused" FAIL "it seeded unknown-owner rows"
else
    record "seed without a run id is refused" PASS "exit non-zero"
fi

# A malformed run id must refuse, since it is embedded in emails and asset tags.
if seed "BAD_RUN_ID" --users 2 >"${WORK}/bad-runid.log" 2>&1; then
    record "malformed run id is refused" FAIL "it accepted an unsafe id"
else
    record "malformed run id is refused" PASS "exit non-zero"
fi

echo "== per-run cleanup =="

# Deleting run A must remove only A's rows.
if seed "$RUN_A" --delete >"${WORK}/del-a.log" 2>&1; then
    a_after="$(count_users "$RUN_A")"; b_after="$(count_users "$RUN_B")"
    if [ "$a_after" = "0" ] && [ "$b_after" = "2" ]; then
        record "delete removes only the named run" PASS "a=0 b=2 untouched"
    else
        record "delete removes only the named run" FAIL "a=${a_after} b=${b_after}"
    fi
else
    record "delete removes only the named run" FAIL "delete failed"
fi

# A delete for a run that owns nothing must be a no-op, not an error and not a
# wildcard that sweeps a neighbour.
if seed "it${RUN_ID}-absent" --delete >"${WORK}/del-absent.log" 2>&1; then
    b_after="$(count_users "$RUN_B")"
    if [ "$b_after" = "2" ]; then
        record "delete of an unknown run spares others" PASS "b=2 intact"
    else
        record "delete of an unknown run spares others" FAIL "b=${b_after}"
    fi
else
    record "delete of an unknown run spares others" FAIL "delete of an absent run errored"
fi

echo "== assets are run-owned too =="

RUN_C="it${RUN_ID}-c"
if seed "$RUN_C" --users 1 --assets 5 >"${WORK}/seed-c.log" 2>&1; then
    c_assets="$(count_assets "$RUN_C")"
    if [ "$c_assets" = "5" ]; then
        record "assets carry the run id" PASS "5 tagged"
    else
        record "assets carry the run id" FAIL "found ${c_assets}"
    fi
    # Deleting the run must remove its assets as well as its accounts.
    seed "$RUN_C" --delete >/dev/null 2>&1
    c_assets_after="$(count_assets "$RUN_C")"
    if [ "$c_assets_after" = "0" ] && [ "$(count_users "$RUN_C")" = "0" ]; then
        record "delete removes the run's assets" PASS "assets and users gone"
    else
        record "delete removes the run's assets" FAIL "assets=${c_assets_after}"
    fi
else
    record "assets carry the run id" FAIL "seed with assets failed"
    record "delete removes the run's assets" SKIP "no assets were seeded"
fi

# Leave the database as it was found.
seed "$RUN_B" --delete >/dev/null 2>&1 || true

echo "== owned-resource cleanup =="
# Tear down what this run created BEFORE checking, otherwise the check simply
# observes the harness's own live database and reports a leak that is not one.
if [ "$CONTAINER_CREATED" = true ]; then retry docker rm -f "$CONTAINER" || true; fi
if [ "$VOLUME_CREATED" = true ]; then retry docker volume rm "$VOLUME" || true; fi
if [ "$NETWORK_CREATED" = true ]; then retry docker network rm "$NETWORK" || true; fi
leaked=0
leaked_v=0
leaked_n=0
for _ in $(seq 1 20); do
    leaked=$(docker ps -a --filter "name=${PREFIX}" --format '{{.Names}}' | wc -l)
    leaked_v=$(docker volume ls --filter "name=${PREFIX}" --format '{{.Name}}' | wc -l)
    leaked_n=$(docker network ls --filter "name=${PREFIX}" --format '{{.Name}}' | wc -l)
    [ "$leaked" -eq 0 ] && [ "$leaked_v" -eq 0 ] && [ "$leaked_n" -eq 0 ] && break
    sleep 1
done
if [ "$leaked" -eq 0 ] && [ "$leaked_v" -eq 0 ] && [ "$leaked_n" -eq 0 ]; then
    record "no fixture resources leaked" PASS "containers=0 volumes=0 networks=0"
else
    record "no fixture resources leaked" FAIL "containers=${leaked} volumes=${leaked_v} networks=${leaked_n}"
fi

if [ "$FAIL" -eq 0 ]; then STATUS=PASS; else STATUS=FAIL; fi
echo
echo "passed=${PASS} failed=${FAIL} skipped=${SKIP} overall=${STATUS}"
emit_results "$STATUS"
write_summary "$STATUS"
echo "results written to ${RESULTS}"
if [ "$STATUS" = PASS ]; then exit 0; fi
exit 1

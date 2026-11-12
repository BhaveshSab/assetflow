#!/usr/bin/env bash
#
# Isolated restore integration for CI.
#
# Exercises infra/scripts/restore-verify.sh against real PostgreSQL 16 and the
# real Prisma migration image, using only synthetic data. Nothing here touches
# AWS, production, or any credential: the S3 paths are not used, and the dumps
# are generated locally from a database this run creates.
#
# The point of the script is to prove the *failure* paths as well as the success
# path, because a verification step that cannot fail is not a verification step.
#
# Usage: integration-restore.sh <repo-root>
#
# Environment:
#   RESTORE_MIGRATE_IMAGE  image tag to build the migration tooling as
#                          (default: from the checkout SHA)
# Every resource is prefixed with this run's id and removed on exit, on failure
# and on interruption.

set -uo pipefail

REPO="${1:-$(cd "$(dirname "$0")/../../.." && pwd)}"
cd "$REPO" || { echo "cannot enter ${REPO}" >&2; exit 1; }

RUN_ID="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
PREFIX="assetflow-it-${RUN_ID}"
PG_IMAGE="${POSTGRES_IMAGE:-postgres:16.4-alpine}"
# Debian-based, so a client container can add python3 and psql without apk.
SHA="$(git rev-parse HEAD)"
MIGRATE_IMAGE="${RESTORE_MIGRATE_IMAGE:-assetflow-it-migrate:${SHA}}"
WORK="$(mktemp -d)"
# Results must survive cleanup, which removes $WORK: the CI step and the
# artifact upload read them after the harness has exited.
RESULTS="${RESULTS_FILE:-${REPO}/test-results/restore-integration.json}"
# The human-readable summary sits beside the JSON with the same base name.
RESULTS_TXT="${RESULTS%.json}.txt"
mkdir -p "$(dirname "$RESULTS")"

PASS=0
FAIL=0
SKIP=0
declare -a CASES=()

# ---------------------------------------------------------------- reporting --
record() { # name status detail
    local name="$1" status="$2" detail="${3:-}"
    CASES+=("$(printf '%s\t%s\t%s' "$name" "$status" "$detail")")
    printf '  %-46s %-6s %s\n' "$name" "$status" "$detail"
    case "$status" in
        PASS) PASS=$((PASS + 1)) ;;
        FAIL) FAIL=$((FAIL + 1)) ;;
        SKIP) SKIP=$((SKIP + 1)) ;;
    esac
}

write_summary() {
    local status="$1"
    [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0
    {
        echo "### Isolated restore integration (synthetic data, no production)"
        echo
        echo "Commit \`${SHA}\`. PostgreSQL 16 + real Prisma migration image."
        echo "This is a CI integration result. It is **not** an AWS performance"
        echo "measurement and **not** production recovery evidence."
        echo
        echo "| Result | Count |"
        echo "|---|---|"
        echo "| Passed | ${PASS} |"
        echo "| Failed | ${FAIL} |"
        echo "| Skipped | ${SKIP} |"
        echo
        echo "| Case | Outcome | Detail |"
        echo "|---|---|---|"
        local row name verdict detail
        for row in "${CASES[@]}"; do
            IFS=$'\t' read -r name verdict detail <<<"$row"
            echo "| ${name} | ${verdict} | ${detail//|/\\|} |"
        done
        echo
        echo "Overall: **${status}**"
    } >>"$GITHUB_STEP_SUMMARY"
}

emit_results() {
    local status="$1"
    {
        printf '{\n  "commit": "%s",\n  "overall": "%s",\n' "$SHA" "$status"
        printf '  "passed": %d, "failed": %d, "skipped": %d,\n' "$PASS" "$FAIL" "$SKIP"
        printf '  "cases": [\n'
        local row name verdict detail first=1
        for row in "${CASES[@]}"; do
            IFS=$'\t' read -r name verdict detail <<<"$row"
            [[ $first -eq 1 ]] || printf ',\n'
            first=0
            detail="${detail//\\/\\\\}"; detail="${detail//\"/\\\"}"
            printf '    {"name": "%s", "outcome": "%s", "detail": "%s"}' "$name" "$verdict" "$detail"
        done
        printf '\n  ]\n}\n'
    } >"$RESULTS"
    {
        echo "== isolated restore integration =="
        echo "commit: ${SHA}"
        echo "results: passed=${PASS} failed=${FAIL} skipped=${SKIP} overall=${status}"
        printf '%s\n' "${CASES[@]}" | while IFS=$'\t' read -r n v d; do echo "  ${v} ${n} ${d}"; done
    } >"$RESULTS_TXT"
    # Surface the failures as annotations too. Log download needs repository admin
    # rights, and artifact download needs authentication, so without this a
    # failing run is visible only as "exit code 1".
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
        local row name verdict detail
        for row in "${CASES[@]}"; do
            IFS=$'\t' read -r name verdict detail <<<"$row"
            [ "$verdict" = FAIL ] || continue
            detail="${detail//'%'/'%25'}"; detail="${detail//$'\r'/'%0D'}"; detail="${detail//$'\n'/'%0A'}"
            printf '::error title=restore integration: %s::%s\n' "$name" "$detail"
        done
        printf '::notice title=restore integration counts::passed=%s failed=%s skipped=%s overall=%s\n' \
            "$PASS" "$FAIL" "$SKIP" "$status"
    fi
}

# ------------------------------------------------------------------ cleanup --
DB=""
NET=""
VOL=""
CLEANED=false
cleanup() {
    local code=$?
    if [ "$CLEANED" = true ]; then return $code; fi
    CLEANED=true
    [ -z "$DB" ] || docker rm -f "$DB" >/dev/null 2>&1 || true
    [ -z "$VOL" ] || docker volume rm "$VOL" >/dev/null 2>&1 || true
    [ -z "$NET" ] || docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "$WORK"
    return $code
}
trap cleanup EXIT INT TERM

say() { printf '%s\n' "$*"; }

# ------------------------------------------------------- build the image ----
say "== building the migration image (the real migrate target) =="
# Reuse the shipped migrate stage rather than a hand-rolled Dockerfile: the
# Prisma CLI is a devDependency, so an `npm ci --omit=dev` image would not
# contain node_modules/prisma/build/index.js and the restore would fail for a
# reason unrelated to the backup. This target is what production runs.
if ! docker build -q -f infra/docker/Dockerfile.api --target migrate \
    -t "$MIGRATE_IMAGE" . >"${WORK}/build.log" 2>&1; then
    record "build migration image" FAIL "$(tail -3 "${WORK}/build.log" | tr '\n' ' ')"
    emit_results FAIL; write_summary FAIL; exit 1
fi
record "build migration image" PASS "$MIGRATE_IMAGE (target migrate)"

# ------------------------------------------------- a database to dump from ---
say "== creating the synthetic source database =="
NET="${PREFIX}-net"
VOL="${PREFIX}-vol"
SRC="${PREFIX}-src"
docker network create --internal "$NET" >/dev/null || { record "create network" FAIL; emit_results FAIL; write_summary FAIL; exit 1; }
docker volume create "$VOL" >/dev/null
# Pull is allowed for these disposable test images: the runner has no preloaded
# Postgres, and nothing here is a production artefact. ($PG_IMAGE and
# $PG_IMAGE is the only image this harness is permitted to fetch.)
if ! docker run -d --name "$SRC" --network "$NET" --network-alias src-db \
    -e POSTGRES_USER=assetflow -e POSTGRES_PASSWORD="it-${RUN_ID}" -e POSTGRES_DB=assetflow \
    -v "${VOL}:/var/lib/postgresql/data" "$PG_IMAGE" >"${WORK}/pg-run.log" 2>&1; then
    record "start postgres" FAIL "$(tail -3 "${WORK}/pg-run.log" | tr '\n' ' ')"
    emit_results FAIL; write_summary FAIL; exit 1
fi
DB="$SRC"

# Readiness: poll, and report the last response rather than guessing. The first
# attempt can legitimately fail while initdb runs on a fresh volume.
ready=false
last_probe=""
for attempt in $(seq 1 90); do
    if probe=$(docker exec "$SRC" pg_isready -U assetflow -d assetflow 2>&1); then
        ready=true
        last_probe="$probe (attempt ${attempt})"
        break
    fi
    last_probe="$probe"
    # A container that exited will never become ready; stop waiting on it.
    if [ "$(docker inspect -f '{{.State.Running}}' "$SRC" 2>/dev/null)" != true ]; then
        last_probe="container exited: $(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "$SRC" 2>/dev/null); ${last_probe}"
        break
    fi
    sleep 1
done
if [ "$ready" != true ]; then
    record "postgres ready" FAIL "${last_probe}; logs: $(docker logs --tail 8 "$SRC" 2>&1 | tr '\n' ' ')"
    emit_results FAIL; write_summary FAIL; exit 1
fi
record "postgres ready" PASS "$PG_IMAGE (${last_probe})"

# Apply the real migrations, then insert synthetic rows.
say "== applying migrations and seeding synthetic data =="
SRC_URL="postgresql://assetflow:it-${RUN_ID}@src-db:5432/assetflow"
if docker run --rm --pull never --network "$NET" -e DATABASE_URL="$SRC_URL" \
    --entrypoint node "$MIGRATE_IMAGE" node_modules/prisma/build/index.js migrate deploy >/dev/null 2>&1
then
    record "prisma migrate deploy (source)" PASS "all migrations applied"
else
    record "prisma migrate deploy (source)" FAIL "migrations did not apply"
    emit_results FAIL; write_summary FAIL; exit 1
fi

SEED_SQL=$(cat <<'SQL'
INSERT INTO "Department"(id,name,"createdAt","updatedAt") VALUES ('d1','Ops',now(),now());
INSERT INTO "AssetCategory"(id,name,"createdAt","updatedAt") VALUES ('c1','Tools',now(),now());
INSERT INTO "User"(id,email,name,role,status,"createdAt","updatedAt")
  VALUES ('u1','admin@example.test','Admin','ADMIN','ACTIVE',now(),now()),
         ('u2','emp@example.test','Emp','EMPLOYEE','ACTIVE',now(),now());
INSERT INTO "Asset"(id,"assetTag",name,"categoryId",status,"createdAt","updatedAt")
  VALUES ('a1','TAG-1','Drill','c1','AVAILABLE',now(),now());
INSERT INTO "Booking"(id,"assetId","bookedById","startTime","endTime",status,"createdAt","updatedAt")
  VALUES ('b1','a1','u1',now(),now()+interval '1 hour','UPCOMING',now(),now());
SQL
)
if printf '%s\n' "$SEED_SQL" | docker exec -i "$SRC" psql -U assetflow -d assetflow -v ON_ERROR_STOP=1 -q >${WORK}/seed.log 2>&1; then
    record "seed synthetic data" PASS "2 users, 1 asset, 1 booking"
else
    record "seed synthetic data" FAIL "$(tail -2 ${WORK}/seed.log | tr '\n' ' ')"
    emit_results FAIL; write_summary FAIL; exit 1
fi

# --------------------------------------------- the constraint SQL contract ---
say "== verifying the shipped constraint SQL against real PostgreSQL =="
# Run against the source database from a throwaway client container that carries
# both psql and python3, on the same isolated network. The database itself keeps
# no published port.
# psql runs inside the database container itself (it ships with the image), so
# no client image and no python3-inside-a-container is needed. The Python driver
# runs on the runner, which always has python3.
PSQL_WRAPPER="${WORK}/psql-in-source.sh"
cat >"$PSQL_WRAPPER" <<WRAP
#!/usr/bin/env bash
exec docker exec -i -e PGPASSWORD=it-${RUN_ID} ${SRC} psql -U assetflow -d assetflow -X -q -tA -v ON_ERROR_STOP=1 "\$@"
WRAP
chmod +x "$PSQL_WRAPPER"
CONSTRAINT_OK=false
if PSQL_BIN="$PSQL_WRAPPER" RESTORE_TEST_DB_URL="ignored" \
    python3 infra/tests/integration/verify-constraint-sql.py >"${WORK}/constraint.log" 2>&1
then
    CONSTRAINT_OK=true
fi
if [ "$CONSTRAINT_OK" = true ]; then
    record "constraint SQL contract (real pg)" PASS "$(grep -c '^  ok' "${WORK}/constraint.log") assertions"
else
    record "constraint SQL contract (real pg)" FAIL "$(tail -4 "${WORK}/constraint.log" | tr '\n' ' ')"
fi

# --------------------------------------------------- dump: current release --
say "== creating backups for the restore cases =="
CURRENT_DUMP="${WORK}/assetflow-current.dump"
docker exec "$SRC" pg_dump -U assetflow -d assetflow --no-owner --no-privileges -Fc >"$CURRENT_DUMP" 2>/dev/null
if [ -s "$CURRENT_DUMP" ]; then
    ( cd "$WORK" && sha256sum "$(basename "$CURRENT_DUMP")" > "assetflow-current.dump.sha256" )
    record "dump current release" PASS "$(du -h "$CURRENT_DUMP" | cut -f1)"
else
    record "dump current release" FAIL "pg_dump produced nothing"
fi

# An older backup: the schema as it was before the constraint migrations.
# This is what a backup taken by a previous release looks like — valid data, but
# a schema the current release must migrate forward.
OLDER_DUMP="${WORK}/assetflow-older.dump"
OLDER_OK=true
docker exec -i "$SRC" psql -U assetflow -d assetflow -q -v ON_ERROR_STOP=1 >${WORK}/relax.log 2>&1 <<'SQL' || OLDER_OK=false
DROP INDEX IF EXISTS "Allocation_one_active_per_asset";
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_no_overlap";
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_time_order";
DELETE FROM "_prisma_migrations" WHERE migration_name IN
  ('20261108090000_allocation_one_active_per_asset','20261108090100_booking_no_overlap');
SQL
if [ "$OLDER_OK" = true ]; then
    docker exec "$SRC" pg_dump -U assetflow -d assetflow --no-owner --no-privileges -Fc >"$OLDER_DUMP" 2>/dev/null
    ( cd "$WORK" && sha256sum "$(basename "$OLDER_DUMP")" > "assetflow-older.dump.sha256" )
    if [ -s "$OLDER_DUMP" ]; then
        record "build older backup" PASS "constraint migrations absent"
    else
        record "build older backup" FAIL "pg_dump produced nothing"
        OLDER_OK=false
    fi
else
    record "build older backup" FAIL "could not relax the schema"
fi

# ------------------------------------------------ drive the real script ------
run_restore() { # dump expected_exit label
    local dump="$1" want="$2" label="$3"
    local slug out
    slug="$(printf '%s' "$label" | tr -c 'a-zA-Z0-9' '_')"
    out="${WORK}/case-${slug}.log"
    RESTORE_MIGRATE_IMAGE="$MIGRATE_IMAGE" LOG_FILE=/dev/null \
        timeout --kill-after=10s 300s \
        bash infra/scripts/restore-verify.sh --from "$dump" >"$out" 2>&1
    local got=$?
    if [ "$got" = "$want" ]; then
        record "$label" PASS "exit ${got}"
    else
        # Report the last meaningful line, plus any restore container state, so
        # an infrastructure race is distinguishable from a real verdict.
        local detail
        detail="$(grep -v '^+ ' "$out" | tail -3 | tr '\n' ' ')"
        record "$label" FAIL "exit ${got}, wanted ${want}: ${detail}"
    fi
}


say "== restore cases through the real script =="
if [ -s "$CURRENT_DUMP" ]; then
    run_restore "$CURRENT_DUMP" 0 "current backup restores and verifies"
fi
if [ -s "$OLDER_DUMP" ]; then
    run_restore "$OLDER_DUMP" 0 "older backup migrates forward and verifies"
fi

# Checksum corruption: flip a byte in the dump, keep the old sidecar.
if [ -s "$CURRENT_DUMP" ]; then
    cp "$CURRENT_DUMP" "${WORK}/corrupt.dump"
    cp "${WORK}/assetflow-current.dump.sha256" "${WORK}/corrupt.dump.sha256"
    printf 'X' | dd of="${WORK}/corrupt.dump" bs=1 seek=200 conv=notrunc status=none 2>/dev/null
    run_restore "${WORK}/corrupt.dump" 1 "corrupt dump is refused"

    # A missing sidecar must also be refused: an unverifiable dump is not restorable.
    cp "$CURRENT_DUMP" "${WORK}/nosidecar.dump"
    run_restore "${WORK}/nosidecar.dump" 1 "dump without checksum is refused"

    # A sidecar naming a different file must be refused.
    cp "$CURRENT_DUMP" "${WORK}/misnamed.dump"
    cp "${WORK}/assetflow-current.dump.sha256" "${WORK}/misnamed.dump.sha256"
    run_restore "${WORK}/misnamed.dump" 1 "misnamed checksum sidecar is refused"
fi

# Migration history mismatch: a dump whose _prisma_migrations disagrees.
if [ -s "$CURRENT_DUMP" ]; then
    docker exec -i "$SRC" psql -U assetflow -d assetflow -q -v ON_ERROR_STOP=1 \
        -c "UPDATE \"_prisma_migrations\" SET checksum = repeat('0',64) WHERE migration_name = '20260712071016_init'" >/dev/null 2>&1
    MISMATCH="${WORK}/assetflow-mismatch.dump"
    docker exec "$SRC" pg_dump -U assetflow -d assetflow --no-owner --no-privileges -Fc >"$MISMATCH" 2>/dev/null
    ( cd "$WORK" && sha256sum "$(basename "$MISMATCH")" > "assetflow-mismatch.dump.sha256" )
    run_restore "$MISMATCH" 1 "migration history mismatch is refused"
fi

# Incorrect constraints: a dump whose migration history claims the constraint
# migrations ran, but whose objects are absent. This is the dangerous case — the
# schema lies about what it enforces. Migrations will not re-run, so the check
# must fail rather than pass on a database that has lost its guarantees.
if [ -s "$CURRENT_DUMP" ] && [ "$OLDER_OK" = true ]; then
    docker exec -i "$SRC" psql -U assetflow -d assetflow -q -v ON_ERROR_STOP=1 >${WORK}/lie.log 2>&1 <<'SQL'
DROP INDEX IF EXISTS "Allocation_one_active_per_asset";
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_no_overlap";
SQL
    LIE="${WORK}/assetflow-lie.dump"
    docker exec "$SRC" pg_dump -U assetflow -d assetflow --no-owner --no-privileges -Fc >"$LIE" 2>/dev/null
    ( cd "$WORK" && sha256sum "$(basename "$LIE")" > "assetflow-lie.dump.sha256" )
    # History still says applied, so this must be rejected.
    run_restore "$LIE" 1 "constraints missing despite applied history is refused"
fi

# ------------------------------------------------- interruptions and cleanup --
say "== interruption leaves nothing behind =="
if [ -s "$CURRENT_DUMP" ]; then
    # Start a restore and interrupt it. The trap must remove the run-owned
    # network, volume and container even though the run never finished.
    if [ -f "${WORK}/assetflow-current.dump.sha256" ]; then
        RESTORE_MIGRATE_IMAGE="$MIGRATE_IMAGE" LOG_FILE=/dev/null \
            bash infra/scripts/restore-verify.sh --from "$CURRENT_DUMP" >"${WORK}/interrupt.log" 2>&1 &
        inter=$!
        sleep 6
        kill -TERM "$inter" 2>/dev/null || true
        wait "$inter" 2>/dev/null
        # Cleanup retries volume removal (a container release can lag), so allow
        # it to settle rather than sampling the instant the script returns.
        # Cleanup retries removals with backoff, so a successful cleanup can
        # take longer than a short window. Poll generously AND poll every
        # resource type the run creates: the previous version did not watch
        # networks at all and gave up after 20s, so a slow-but-successful
        # cleanup was reported as a leak.
        leaked=0
        leaked_v=0
        leaked_n=0
        for _ in $(seq 1 60); do
            leaked=$(docker ps -a --filter "name=assetflow-restore-verify-" --format '{{.Names}}' | wc -l)
            leaked_v=$(docker volume ls --filter "name=assetflow-restore-verify-" --format '{{.Name}}' | wc -l)
            leaked_n=$(docker network ls --filter "name=assetflow-restore-verify-" --format '{{.Name}}' | wc -l)
            [ "$leaked" -eq 0 ] && [ "$leaked_v" -eq 0 ] && [ "$leaked_n" -eq 0 ] && break
            sleep 1
        done
        if [ "$leaked" -eq 0 ] && [ "$leaked_v" -eq 0 ] && [ "$leaked_n" -eq 0 ]; then
            record "interrupted run cleans up" PASS "SIGTERM handled, nothing left"
        else
            # Surface why cleanup failed, not merely that something remains.
            why=$(grep -i "cleanup failed" "${WORK}/interrupt.log" 2>/dev/null | tail -1 || true)
            # And identify WHAT remains, so the next run cannot be a guess: the
            # network's creation timestamp says which invocation leaked it.
            detail="containers=${leaked} volumes=${leaked_v} networks=${leaked_n} after 60s${why:+ - ${why}}"
            if [ "$leaked_n" -gt 0 ]; then
                NETINFO=$(docker network ls --filter "name=assetflow-restore-verify-" \
                    --format '{{.Name}} created={{.CreatedAt}}' 2>/dev/null | head -3 || true)
                detail="${detail} leaked: ${NETINFO}"
            fi
            # The interrupted run's own log shows whether its cleanup trap ran
            # and with which regime ("cleanup invoked: regime=..."). No such
            # line means the trap never ran; a sweep line with a success means
            # the removals themselves failed.
            LOGLAST=$(tail -12 "${WORK}/interrupt.log" 2>/dev/null | tr '\n' '|' || true)
            detail="${detail} log[${#LOGLAST}]: ${LOGLAST:0:400}"
            record "interrupted run cleans up" FAIL "$detail"
        fi
    fi
fi

# ------------------------------------------------- owned-resource cleanup ----
say "== owned-resource cleanup =="
leftover_containers=0
leftover_volumes=0
leftover_networks=0
for _ in $(seq 1 20); do
    leftover_containers=$(docker ps -a --filter "name=assetflow-restore-verify-" --format '{{.Names}}' | wc -l)
    leftover_volumes=$(docker volume ls --filter "name=assetflow-restore-verify-" --format '{{.Name}}' | wc -l)
    leftover_networks=$(docker network ls --filter "name=assetflow-restore-verify-" --format '{{.Name}}' | wc -l)
    [ "$leftover_containers" -eq 0 ] && [ "$leftover_volumes" -eq 0 ] && [ "$leftover_networks" -eq 0 ] && break
    sleep 1
done
if [ "$leftover_containers" -eq 0 ] && [ "$leftover_volumes" -eq 0 ] && [ "$leftover_networks" -eq 0 ]; then
    record "no restore resources leaked" PASS "containers=0 volumes=0 networks=0"
else
    detail="containers=${leftover_containers} volumes=${leftover_volumes} networks=${leftover_networks}"
    if [ "$leftover_networks" -gt 0 ]; then
        NETINFO=$(docker network ls --filter "name=assetflow-restore-verify-" \
            --format '{{.Name}} created-{{.CreatedAt}}' 2>/dev/null | head -3 || true)
        detail="${detail} leaked: ${NETINFO}"
    fi
    record "no restore resources leaked" FAIL "$detail"
fi

# -------------------------------------------------------------- verdict ------
if [ "$FAIL" -eq 0 ]; then
    STATUS=PASS
else
    STATUS=FAIL
fi
emit_results "$STATUS"
write_summary "$STATUS"

say ""
say "passed=${PASS} failed=${FAIL} skipped=${SKIP} overall=${STATUS}"
say "results written to ${RESULTS}"
# Exit explicitly on the verdict. Under `set -o pipefail` the surrounding CI step
# takes its status from this script, and any late non-zero from a reporting helper
# must not be mistaken for a test failure.
if [ "$STATUS" = PASS ]; then
    exit 0
fi
exit 1

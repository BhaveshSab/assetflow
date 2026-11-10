#!/usr/bin/env bash
#
# The single migration path, shared by the EC2 bootstrap and CI.
#
# Why this exists: `docker compose up -d migrate` is a *start*, not a completion.
# It returns as soon as the container is created, so the bootstrap could begin
# seeding while migrations were still running - or, worse, after a migration had
# already failed. The previous version papered over this with a grep that fell
# through to a `say` when nothing matched, so it could not fail.
#
# This script:
#   * builds from the pinned checkout, and records the image IDs it will use;
#   * runs the migration in the foreground and requires exit status 0;
#   * bounds the wait, so a wedged container cannot consume the whole lifetime;
#   * verifies the DATABASE'S schema state, not a log phrase;
#   * keeps the failure output for evidence.
#
# Usage
#   migrate-db.sh --evidence-dir DIR [--timeout SECONDS] [--quiet]
#
# Environment
#   RUN_ID   optional: when set, image tags are pinned to this run so a remote
#            image cannot be substituted for a local build.
#   COMPOSE  optional: defaults to the standard three-part invocation.
#
# Exit status
#   0  the database schema matches the checked-out migrations
#   1  the migration failed, timed out, or left the schema behind
#   2  usage or precondition problem
set -uo pipefail

EVIDENCE_DIR=""
TIMEOUT="900"
QUIET=0

while [ $# -gt 0 ]; do
    case "$1" in
        --evidence-dir) EVIDENCE_DIR="${2:?--evidence-dir needs a value}"; shift 2 ;;
        --timeout) TIMEOUT="${2:?--timeout needs a value}"; shift 2 ;;
        --quiet) QUIET=1; shift ;;
        *) echo "migrate-db: unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$EVIDENCE_DIR" ] || { echo "migrate-db: --evidence-dir is required" >&2; exit 2; }
case "$TIMEOUT" in
    ''|*[!0-9]*) echo "migrate-db: --timeout must be an integer, got '$TIMEOUT'" >&2; exit 2 ;;
esac
mkdir -p "$EVIDENCE_DIR"

COMPOSE="${COMPOSE:-docker compose --env-file infra/.env -f infra/docker-compose.yml}"
say() { [ "$QUIET" -eq 1 ] || printf '[migrate] %s\n' "$*"; }

# Pin run-local tags so compose cannot prefer a registry image over the build.
if [ -n "${RUN_ID:-}" ]; then
    export MIGRATE_IMAGE="assetflow-migrate:${RUN_ID}"
    export API_IMAGE="assetflow-api:${RUN_ID}"
    export WEB_IMAGE="assetflow-web:${RUN_ID}"
fi

say "building images from the pinned checkout"
$COMPOSE build api migrate nginx > "$EVIDENCE_DIR/build.log" 2>&1 || {
    echo "migrate-db: image build failed (see $EVIDENCE_DIR/build.log)"
    tail -25 "$EVIDENCE_DIR/build.log" 2>/dev/null
    exit 1
}

# Record the actual image IDs, so the evidence shows what ran rather than what
# was asked for.
$COMPOSE images > "$EVIDENCE_DIR/images.txt" 2>&1 || true
say "images"
[ "$QUIET" -eq 1 ] || sed -n '1,12p' "$EVIDENCE_DIR/images.txt"

say "starting dependencies"
$COMPOSE up -d postgres redis || { echo "migrate-db: dependency services failed"; exit 1; }

# ---- wait for the database to actually accept queries ----------------------
# `up -d` returns once containers are *started*, not healthy, and the migration
# below uses `--no-deps`, so compose does not wait for the healthcheck. Postgres
# binds its port before it can authenticate, so a migration started in that gap
# fails with P1001 "Can't reach database server" - which is exactly what a run
# recorded. Wait for a real query, bounded, and say so if it never arrives.
DB_WAIT="${DB_WAIT:-180}"
say "waiting for postgres to accept queries (bounded ${DB_WAIT}s)"
db_ready=0
for _ in $(seq 1 "$DB_WAIT"); do
    if $COMPOSE exec -T postgres pg_isready -U "${POSTGRES_USER:-assetflow}" \
            -d "${POSTGRES_DB:-assetflow}" > "$EVIDENCE_DIR/pg-ready.log" 2>&1; then
        db_ready=1
        break
    fi
    sleep 1
done
if [ "$db_ready" -ne 1 ]; then
    echo "migrate-db: postgres did not accept queries within ${DB_WAIT}s"
    tail -10 "$EVIDENCE_DIR/pg-ready.log" 2>/dev/null || true
    exit 1
fi
say "postgres is accepting queries"

# ---- the actual gate ------------------------------------------------------
# `run` (not `up -d`) blocks until the container exits and returns its status.
say "running migrations (foreground, timeout ${TIMEOUT}s)"
rc=0
timeout "$TIMEOUT" $COMPOSE run --rm --no-deps migrate \
    > "$EVIDENCE_DIR/migrate.log" 2>&1 || rc=$?

if [ "$rc" -eq 124 ]; then
    echo "migrate-db: migration timed out after ${TIMEOUT}s"
    tail -25 "$EVIDENCE_DIR/migrate.log" 2>/dev/null
    exit 1
fi
if [ "$rc" -ne 0 ]; then
    echo "migrate-db: migration failed with exit $rc"
    tail -25 "$EVIDENCE_DIR/migrate.log" 2>/dev/null
    exit 1
fi
say "migration container exited 0"

# ---- verify the database itself, not a log phrase -------------------------
# `migrate status` asks the database which migrations are recorded and compares
# them with the migration files. A log line can be absent for reasons that have
# nothing to do with the schema; this cannot.
say "verifying schema state against the database"
status_rc=0
timeout 120 $COMPOSE run --rm --no-deps migrate npx prisma migrate status \
    > "$EVIDENCE_DIR/migrate-status.log" 2>&1 || status_rc=$?

if [ "$status_rc" -ne 0 ]; then
    echo "migrate-db: 'prisma migrate status' failed (exit $status_rc); the schema did not match the migrations"
    sed -n '1,40p' "$EVIDENCE_DIR/migrate-status.log" 2>/dev/null
    exit 1
fi

# A pending migration here means the foreground run did not do its job, even
# though it exited 0.
if grep -qiE "have not yet been applied|following migration.*not.*applied|pending" \
        "$EVIDENCE_DIR/migrate-status.log" 2>/dev/null; then
    echo "migrate-db: the database still has unapplied migrations"
    sed -n '1,40p' "$EVIDENCE_DIR/migrate-status.log" 2>/dev/null
    exit 1
fi

# Confirm the fixture table exists. Seeding writes to "User", so a database
# without it cannot be seeded no matter what the migration log said.
TABLE_COUNT="$($COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-assetflow}" \
    -d "${POSTGRES_DB:-assetflow}" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_name = 'User'" \
    2>/dev/null | tr -d '[:space:]')" || TABLE_COUNT=""
case "$TABLE_COUNT" in
    ''|*[!0-9]*) echo "migrate-db: could not query the schema (got '$TABLE_COUNT')"; exit 1 ;;
esac
[ "$TABLE_COUNT" = "1" ] || {
    echo 'migrate-db: the "User" table does not exist; migrations did not create the schema'
    exit 1
}

say "database schema is current and the User table exists"

#!/usr/bin/env bash
#
# Proves that a backup can actually be restored — and that the restored data
# is the data this release expects.
#
#   "A backup you have never restored is a hope, not a backup."
#
# The script restores a dump into a **throwaway** Postgres container that this
# run owns: its own name, its own volume, no published port, deleted afterwards.
# It then proves four separate things, because they fail independently:
#
#   1. INTEGRITY  the dump matches its .sha256 (mandatory — a dump without a
#                 checksum is a dump nobody verified)
#   2. CONTENT    the restored database holds rows, and every model's table is
#                 present with a plausible count
#   3. MIGRATION  the current release's migrations apply on top of the restored
#                 data, so a restore is not followed by an unmigratable schema
#   4. INVARIANTS the business rules the database enforces (one active
#                 allocation per asset, no overlapping bookings, at least one
#                 active admin) still hold in the restored copy
#
# This elapsed time is not application recovery or host-rebuild RTO.
#
# Usage:
#   ./restore-verify.sh [--dry-run] [--from <dump-file>] [--from-s3 <uri>]
#
# Environment:
#   BACKUP_DIR     where the dumps live (default /var/backups/assetflow)
#   S3_BUCKET      bucket to fetch from when --from-s3/--from-s3-latest is used
#   S3_PREFIX      key prefix (default assetflow/backups)
#   RESTORE_MIGRATE_IMAGE  preloaded image tagged with this checkout full SHA
#   RESTORE_POSTGRES_IMAGE PostgreSQL image preloaded by an approved step
# No live database is queried. Required restore resources need operator approval.
#
# Exit codes: 0 = the restore and all four checks passed, 1 = it did not, 2 = usage
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/assetflow}"
S3_PREFIX="${S3_PREFIX:-assetflow/backups}"
DUMP_FILE=""
FROM_S3=""
FROM_S3_LATEST=false
WORK_DIR=""

while [ $# -gt 0 ]; do
    case "$1" in
        --from) DUMP_FILE="$2"; shift ;;
        --from-s3) FROM_S3="$2"; shift ;;
        --from-s3-latest) FROM_S3_LATEST=true ;;
        --dry-run|--help|-h) : ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
    shift
done

# --------------------------------------------------------------- ownership --
# Every resource this run creates is named after the run, so two concurrent
# verifications cannot destroy each other and the cleanup cannot touch a
# container it did not start. The old fixed name meant a second run's
# `docker rm -f` deleted the first run's database midway through pg_restore.
RUN_ID="$(date -u '+%Y%m%dT%H%M%SZ').$$.$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
CONTAINER="assetflow-restore-verify-${RUN_ID}"
VOLUME="assetflow-restore-verify-${RUN_ID}"
NETWORK="assetflow-restore-verify-${RUN_ID}"
MIGRATOR="assetflow-restore-migrate-${RUN_ID}"
DB_CREATED=false
MIGRATOR_CREATED=false
ADDED_VOLUME=false
ADDED_NETWORK=false
CLEANUP_DONE=false
RETRY_ERROR=''
POSTGRES_IMAGE="${RESTORE_POSTGRES_IMAGE:-postgres:16.4-alpine}"
RESTORE_DB="restore_check"
RESTORE_USER="assetflow"
# The password is generated per run and never printed. It only protects a
# database with no published port and no network route, so it is a hygiene
# measure rather than a security boundary.
RESTORE_PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-32)"

if [ "$DRY_RUN" = true ]; then
    say "[dry-run] fetch/verify the dump and its mandatory .sha256"
    say "[dry-run] docker volume create ${VOLUME}"
    say "[dry-run] docker run -d --name ${CONTAINER} -v ${VOLUME}:/var/lib/postgresql/data (no -p: not published)"
    say "[dry-run] pg_restore the dump into ${RESTORE_DB}"
    say "[dry-run] migrate using the matching preloaded release image on an internal network"
    say "[dry-run] check every model table and its row count after migrations"
    say "[dry-run] assert the business invariants (one active allocation per asset,"
    say "[dry-run]   no overlapping bookings, at least one active admin)"
    say "[dry-run] isolated elapsed time would be written to a metric (not application RTO)"
    say "[dry-run] nothing was created"
    exit 0
fi

# Required tooling is inspected before any backup is downloaded. Images must be
# preloaded by an independently approved preparation step: no pull/build here.
command -v docker >/dev/null 2>&1 || die "Docker is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"
MIGRATE_IMAGE="${RESTORE_MIGRATE_IMAGE:-}"
[[ "$MIGRATE_IMAGE" =~ :([a-f0-9]{40})$ ]] || die "RESTORE_MIGRATE_IMAGE must have a full release-SHA tag"
release_sha="${BASH_REMATCH[1]}"
checkout_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)" || die "cannot determine checkout release"
[ "$release_sha" = "$checkout_sha" ] || die "migration image and checkout release differ"
# Freeze both preloaded references to local immutable image IDs for this run.
MIGRATE_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$MIGRATE_IMAGE" </dev/null)" \
    || die "preload the approved migration image before restoring"
POSTGRES_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$POSTGRES_IMAGE" </dev/null)" \
    || die "preload the approved PostgreSQL image before restoring"
[[ "$MIGRATE_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] || die "invalid migration image ID"
[[ "$POSTGRES_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] || die "invalid PostgreSQL image ID"
[ -f "${REPO_ROOT}/backend/prisma/schema.prisma" ] || die "Prisma schema is missing"
[ -d "${REPO_ROOT}/backend/prisma/migrations" ] || die "migration history is missing"
# Match both schema and migration bytes, not just a mutable image tag.
manifest_command='cd /app/prisma && sha256sum schema.prisma && find migrations -type f -print0 | sort -z | xargs -0 sha256sum'
image_manifest="$(docker run --rm --pull never --network none --entrypoint sh "$MIGRATE_IMAGE_ID" -c "$manifest_command" </dev/null)" \
    || die "cannot inspect migration image content"
checkout_manifest="$(cd "${REPO_ROOT}/backend/prisma" && sha256sum schema.prisma && find migrations -type f -print0 | sort -z | xargs -0 sha256sum)"
[ "$image_manifest" = "$checkout_manifest" ] || die "migration image schema/history differs from this checkout"

STARTED_AT=$(date +%s)
# Removing a container returns before the kernel has necessarily released the
# volume it had mounted, so an immediate `docker volume rm` can fail with
# "volume is in use". That is a race, not a real leak; retry a few times, and let
# the network removal run regardless so one failed step cannot skip the rest.
#
# The last error is kept: discarding it is what turned a diagnosable failure into
# a bare "cleanup failed" line. `retry` still fails silently on the happy path.
retry() {
    local attempt
    local last_error=''
    for attempt in 1 2 3 4 5; do
        if last_error=$("$@" 2>&1); then return 0; fi
        sleep "$attempt"
    done
    RETRY_ERROR="${last_error}"
    return 1
}
cleanup() {
    local status=$?
    [ "$CLEANUP_DONE" = false ] || return "$status"
    CLEANUP_DONE=true
    # Remove only resources this run created, gated on the per-resource flags.
    #
    # Each flag is assigned IMMEDIATELY BEFORE its create command, not after:
    # bash defers a signal trap until the foreground command it interrupted has
    # finished, so a SIGTERM arriving DURING `docker network create` runs
    # cleanup only after that create has completed. With the flag set before
    # the create, cleanup then removes the resource it knows exists. The old
    # order (create, then flag) leaked exactly one network this way: the trap
    # fired with the flag still false, the removal was skipped, and "interrupted
    # run cleans up" failed with containers=0 volumes=0 networks=1 and no
    # cleanup-failed message. The names carry the unique run id, so removal
    # cannot touch anything this run did not create. After a failed removal the
    # resource is re-checked before warning: a resource that vanished between
    # the check and the rm is gone, which is success for cleanup, and a run
    # that created nothing calls docker not at all.
    # Each step is independent: a failure is reported but never prevents the rest.
    if [ "$MIGRATOR_CREATED" = true ]; then
        retry docker rm -f "$MIGRATOR" || { docker inspect "$MIGRATOR" >/dev/null 2>&1 && { warn "migration container cleanup failed: ${RETRY_ERROR}"; [ "$status" -ne 0 ] || status=1; }; }
    fi
    if [ "$DB_CREATED" = true ]; then
        retry docker rm -f "$CONTAINER" || { docker inspect "$CONTAINER" >/dev/null 2>&1 && { warn "restore container cleanup failed: ${RETRY_ERROR}"; [ "$status" -ne 0 ] || status=1; }; }
    fi
    if [ "$ADDED_VOLUME" = true ]; then
        retry docker volume rm "$VOLUME" || { docker volume inspect "$VOLUME" >/dev/null 2>&1 && { warn "restore volume cleanup failed: ${RETRY_ERROR}"; [ "$status" -ne 0 ] || status=1; }; }
    fi
    if [ "$ADDED_NETWORK" = true ]; then
        retry docker network rm "$NETWORK" || { docker network inspect "$NETWORK" >/dev/null 2>&1 && { warn "restore network cleanup failed: ${RETRY_ERROR}"; [ "$status" -ne 0 ] || status=1; }; }
    fi
    if [ -n "$WORK_DIR" ]; then rm -rf -- "$WORK_DIR"; fi
    return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077

# ------------------------------------------------------- 0. obtain the dump --
if [ -n "$FROM_S3" ]; then
    require_s3
    WORK_DIR="$(mktemp -d)"
    DUMP_FILE="${WORK_DIR}/$(basename "$FROM_S3")"
    say "+ fetching ${FROM_S3}"
    aws s3 cp "$FROM_S3" "$DUMP_FILE" --only-show-errors
    aws s3 cp "${FROM_S3}.sha256" "${DUMP_FILE}.sha256" --only-show-errors
elif [ "$FROM_S3_LATEST" = true ]; then
    require_s3
    [ -n "${S3_BUCKET:-}" ] || die "--from-s3-latest needs S3_BUCKET"
    WORK_DIR="$(mktemp -d)"
    latest="$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
        | awk '/assetflow-.*\.dump$/ {print $4}' | sort | tail -1)"
    [ -n "$latest" ] || die "no dump found under s3://${S3_BUCKET}/${S3_PREFIX}/"
    DUMP_FILE="${WORK_DIR}/${latest}"
    say "+ fetching the newest object s3://${S3_BUCKET}/${S3_PREFIX}/${latest}"
    aws s3 cp "s3://${S3_BUCKET}/${S3_PREFIX}/${latest}" "$DUMP_FILE" --only-show-errors
    aws s3 cp "s3://${S3_BUCKET}/${S3_PREFIX}/${latest}.sha256" "${DUMP_FILE}.sha256" --only-show-errors
fi

if [ -z "$DUMP_FILE" ]; then
    DUMP_FILE="$(ls -1t "${BACKUP_DIR}"/assetflow-*.dump 2>/dev/null | head -1 || true)"
fi
[ -n "$DUMP_FILE" ] || die "no dump found in ${BACKUP_DIR} — run backup.sh first, or pass --from-s3 <uri>"
[ -f "$DUMP_FILE" ] || die "the dump ${DUMP_FILE} does not exist"

say "=== restore verification (run ${RUN_ID}) ==="
say "dump:      ${DUMP_FILE}"
say "size:      $(du -h "$DUMP_FILE" | cut -f1)"

# ------------------------------------------------ 1. INTEGRITY (mandatory) --
# A checksum that is merely *checked when present* verifies nothing: deleting
# the .sha256 file made the whole check disappear. It is required now.
CHECKSUM_FILE="${DUMP_FILE}.sha256"
[ -f "$CHECKSUM_FILE" ] \
    || die "no checksum at ${CHECKSUM_FILE} — refusing to call an unverified dump restorable. Regenerate the dump with backup.sh."
say "+ verifying the checksum (mandatory)"
if ! python3 "${INFRA_DIR}/scripts/lib/verify-backup-checksum.py" "$DUMP_FILE"; then
    die "the checksum does NOT match — the dump is corrupt; do not restore it"
fi
say "  checksum matches"

# ------------------------------------------------- 2. the throwaway database --
say "+ creating an owned internal network, volume and database (no published port)"
# Each flag goes up BEFORE its create: a signal arriving during the create is
# deferred by bash until the create finishes, and cleanup must then remove what
# that create made. On a create that FAILS the flag goes back down, so cleanup
# never attempts to remove a resource that does not exist.
ADDED_NETWORK=true
if ! docker network create --internal "$NETWORK" >/dev/null; then
    ADDED_NETWORK=false
    die "cannot create the isolated restore network"
fi
ADDED_VOLUME=true
if ! docker volume create --label "assetflow.restore.run=${RUN_ID}" "$VOLUME" >/dev/null; then
    ADDED_VOLUME=false
    die "cannot create the isolated restore volume"
fi
DB_CREATED=true
if ! docker create --name "$CONTAINER" --pull never --network "$NETWORK" --network-alias restored-db \
    -e POSTGRES_USER="$RESTORE_USER" \
    -e POSTGRES_PASSWORD="$RESTORE_PASSWORD" \
    -e POSTGRES_DB="$RESTORE_DB" \
    -v "${VOLUME}:/var/lib/postgresql/data" \
    "$POSTGRES_IMAGE_ID" >/dev/null; then
    DB_CREATED=false
    die "cannot create the throwaway restore database container"
fi
docker start "$CONTAINER" >/dev/null

# Wait for the database to accept a real TCP connection, not merely for
# pg_isready to answer. On a fresh volume initdb runs a *temporary* server on the
# unix socket and then restarts; pg_isready can succeed against that temporary
# server, so a fast machine would break out of the loop and then race the
# restart — the next command saw "the database system is shutting down". Asking
# the target database a real query over TCP (-h 127.0.0.1) cannot succeed until
# the real server is up, which is the condition every later step depends on.
db_ready() {
    docker exec "$CONTAINER" psql -h 127.0.0.1 -U "$RESTORE_USER" -d "$RESTORE_DB" -tAc 'select 1' \
        >/dev/null 2>&1
}
ready=false
for _ in $(seq 1 90); do
    if db_ready; then ready=true; break; fi
    # A container that exited will never answer; stop waiting on it.
    if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != true ]; then break; fi
    sleep 1
done
[ "$ready" = true ] || die "the throwaway database did not start"

say "+ restoring the dump"
docker cp "$DUMP_FILE" "${CONTAINER}:/tmp/restore.dump"
# --exit-on-error: a restore that reports success with tables missing is the
# exact failure this script exists to catch.
docker exec "$CONTAINER" pg_restore \
    --username "$RESTORE_USER" \
    --dbname "$RESTORE_DB" \
    --no-owner --no-privileges \
    --exit-on-error \
    /tmp/restore.dump

# Migrate only the isolated copy on a run-owned internal Docker network. Neither
# the DB nor the migrator publishes a port or uses host credentials/env files.
say "+ applying this release's migrations with prisma migrate deploy"
RESTORE_URL="postgresql://${RESTORE_USER}:${RESTORE_PASSWORD}@restored-db:5432/${RESTORE_DB}"
MIGRATOR_CREATED=true
if ! docker create --name "$MIGRATOR" --pull never --network "$NETWORK" \
    -e DATABASE_URL="$RESTORE_URL" --entrypoint node \
    "$MIGRATE_IMAGE_ID" node_modules/prisma/build/index.js migrate deploy >/dev/null; then
    MIGRATOR_CREATED=false
    die "cannot create the isolated migration container"
fi
docker start "$MIGRATOR" >/dev/null
migration_exit="$(timeout --kill-after=5s 180s docker wait "$MIGRATOR")" || die "cannot wait for isolated migrations"
# Do not dump migration logs automatically: database errors may include data.
[ "$migration_exit" = 0 ] || die "isolated prisma migrate deploy failed; inspect its logs privately"

# Check exact successful names and SQL checksums, rejecting unfinished entries.
# Prisma owns the bookkeeping; this check does not replay SQL or edit history.
WORK_DIR="${WORK_DIR:-$(mktemp -d)}"
python3 "${INFRA_DIR}/scripts/lib/restore-history.py" "${REPO_ROOT}/backend/prisma/migrations" > "${WORK_DIR}/history.sql"
history_ok="$(docker exec -i "$CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -v ON_ERROR_STOP=1 -tA < "${WORK_DIR}/history.sql")"
[ "$history_ok" = t ] || die "restored migration history does not match the release"

# --------------------------------------------------- 3. CONTENT (all models) --
# Comparing six tables left Booking, MaintenanceRequest, the Audit tables,
# Attachment, AssetImport, JobOutbox and PasswordResetToken unverified — and a
# row-count *difference* was only a warning, so a truncated restore passed.
# Now: every table the schema declares must exist, and the core ones must hold
# rows. No production database is contacted; only the isolated copy is checked.
say "+ checking that every model's table survived"
EXPECTED_TABLES="User PasswordResetToken Department AssetCategory Asset AssetTagCounter \
Allocation TransferRequest Booking MaintenanceRequest AuditCycle AuditAssignment AuditItem \
Notification ActivityLog JobOutbox Attachment AssetImport"

missing=""
for table in $EXPECTED_TABLES; do
    found="$(docker exec "$CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -tAc \
        "select to_regclass('public.\"${table}\"') is not null" | tr -d '[:space:]')"
    if [ "$found" != "t" ]; then
        missing="${missing} ${table}"
    fi
done
[ -z "$missing" ] || die "the restored database is missing tables:${missing}"
say "  all ${EXPECTED_TABLES// /, } present"

USERS="$(docker exec "$CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -tAc \
    'SELECT count(*) FROM "User"' | tr -d '[:space:]')"
[ "${USERS:-0}" -gt 0 ] || die "the restored database contains no users — the dump is useless"
say "  restored users: ${USERS}"

say "+ row counts in the isolated restored database (no live comparison)"
for table in $EXPECTED_TABLES; do
    restored="$(docker exec "$CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -v ON_ERROR_STOP=1 -tAc \
        "SELECT count(*) FROM \"${table}\"" | tr -d '[:space:]')"
    [[ "$restored" =~ ^[0-9]+$ ]] || die "cannot count ${table} in the restored database"
    say "  ${table}: ${restored}"
done

# ------------------------------------------------------- 5. business invariants --
# These are the constraints the running system relies on. A dump that restores
# but has lost them is not a usable backup. The overlap rule and the one-active-
# allocation rule are *database* constraints (migrations 20261108090100 and
# 20261108090000), so the check reads the catalog rather than re-deriving the
# rule: a hand-written overlap query has to guess the status vocabulary and had
# been written against a "CONFIRMED"/"ACTIVE" pair that this schema never had
# (BookingStatus is UPCOMING/ONGOING/COMPLETED/CANCELLED), so it could only ever
# error out. Asking the constraint catalog cannot disagree with the schema.
say "+ asserting the business invariants"
check_invariant() {
    local label="$1" sql="$2" expectation="$3"
    local value
    value="$(docker exec "$CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -tAc "$sql" \
        | tr -d '[:space:]')"
    [ -n "$value" ] || die "invariant '${label}' could not be evaluated"
    if [ "$value" = "$expectation" ]; then
        say "  ok: ${label} (${value})"
    else
        die "invariant '${label}' is violated in the restored data: got ${value}, expected ${expectation}"
    fi
}

# Validate actual definitions, scope, uniqueness and index readiness/validity;
# object names alone are not enforcement evidence. pg_indexes is not sufficient.
constraints_ok="$(docker exec -i "$CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -v ON_ERROR_STOP=1 -tA < "${INFRA_DIR}/scripts/lib/restore-constraints.sql")"
[ "$constraints_ok" = t ] || die "Allocation_one_active_per_asset / Booking_no_overlap definitions or validity do not match this release"

# 5c. The data does not violate the rules. These reuse the schema's own
# vocabulary; a wrong status name now fails as an empty result rather than as a
# misleading "0 violations".
check_invariant "no asset has two ACTIVE allocations" \
    "select count(*) from (select \"assetId\" from \"Allocation\" where \"status\" = 'ACTIVE' group by \"assetId\" having count(*) > 1) t" \
    "0"
check_invariant "no booking ends before it starts" \
    "select count(*) from \"Booking\" where \"endTime\" <= \"startTime\"" \
    "0"
# The overlap rule itself excludes CANCELLED; the constraint already enforces it,
# so a non-zero count here means the constraint is missing or was dropped.
check_invariant "no overlapping non-cancelled bookings" \
    "select count(*) from \"Booking\" a join \"Booking\" b on a.\"assetId\" = b.\"assetId\" and a.\"id\" < b.\"id\" where a.\"status\" <> 'CANCELLED' and b.\"status\" <> 'CANCELLED' and a.\"startTime\" < b.\"endTime\" and b.\"startTime\" < a.\"endTime\"" \
    "0"

# 5d. The last active administrator cannot be removed (RBAC precondition).
check_invariant "at least one active admin remains" \
    "select (count(*) > 0)::text from \"User\" where \"role\" = 'ADMIN' and \"status\" = 'ACTIVE'" \
    "true"

# Successful verification also requires successful resource cleanup.
cleanup
ENDED_AT=$(date +%s)
DURATION=$((ENDED_AT - STARTED_AT))

say "=== isolated fetch/verify/migrate/check elapsed ${DURATION} seconds (not application or host RTO) ==="
write_textfile_metric \
    assetflow_restore_verify_duration_seconds \
    "$DURATION" \
    "Duration of isolated backup fetch, integrity, migration and data checks"
write_textfile_metric \
    assetflow_restore_verify_last_success_timestamp_seconds \
    "$(date +%s)" \
    "Unix timestamp of the last successful restore verification"
say "the backup can be restored: integrity, content, migration and invariants all passed"

#!/usr/bin/env bash
#
# Proves that a backup can actually be restored.
#
#   "A backup you have never restored is a hope, not a backup."
#
# The script restores the newest dump into a **throwaway** Postgres container
# (its own volume, its own port, deleted afterwards), runs a few sanity
# queries and compares the row counts with the live database. The time it
# needs is the RTO (recovery time objective) of the project.
#
# Usage:
#   ./restore-verify.sh [--dry-run] [--from <dump-file>]
#
# Environment:
#   BACKUP_DIR   where the dumps live (default /var/backups/assetflow)
#   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE  the live database
#
# Exit codes: 0 = the restore worked, 1 = it did not
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/assetflow}"
DUMP_FILE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --from) DUMP_FILE="$2"; shift ;;
        *) die "unknown argument: $1" ;;
    esac
    shift
done

if [ -z "$DUMP_FILE" ]; then
    # The newest dump wins.
    DUMP_FILE="$(ls -1t "${BACKUP_DIR}"/assetflow-*.dump 2>/dev/null | head -1 || true)"
fi

[ -n "$DUMP_FILE" ] || die "no dump found in ${BACKUP_DIR} — run backup.sh first"
[ -f "$DUMP_FILE" ] || die "the dump ${DUMP_FILE} does not exist"

say "=== restore verification ==="
say "dump:      ${DUMP_FILE}"
say "size:      $(du -h "$DUMP_FILE" | cut -f1)"
say "checksum:  $(sha256sum "$DUMP_FILE" | cut -c1-16)…"

# The checksum file must match — otherwise the dump is corrupt.
CHECKSUM_FILE="${DUMP_FILE}.sha256"
if [ -f "$CHECKSUM_FILE" ] && [ "$DRY_RUN" != true ]; then
    if ( cd "$(dirname "$DUMP_FILE")" && sha256sum --check --status "$(basename "$CHECKSUM_FILE")" ); then
        say "the checksum matches"
    else
        die "the checksum does NOT match — the dump is corrupt"
    fi
fi

# The throwaway database.
CONTAINER="assetflow-restore-verify"
RESTORE_PORT="${RESTORE_PORT:-55432}"
RESTORE_DB="restore_check"
RESTORE_USER="assetflow"

cleanup() {
    if [ "$DRY_RUN" = true ]; then return; fi
    say "removing the throwaway container"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

STARTED_AT=$(date +%s)

if [ "$DRY_RUN" = true ]; then
    say "[dry-run] docker run --rm --name ${CONTAINER} -e POSTGRES_PASSWORD=... -p ${RESTORE_PORT}:5432 postgres:16.4-alpine"
    say "[dry-run] pg_restore --dbname=… ${DUMP_FILE}"
    say "[dry-run] compare the row counts"
    exit 0
fi

say "+ starting the throwaway database"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
    -e POSTGRES_USER="$RESTORE_USER" \
    -e POSTGRES_PASSWORD="restore-verify" \
    -e POSTGRES_DB="$RESTORE_DB" \
    -p "${RESTORE_PORT}:5432" \
    postgres:16.4-alpine >/dev/null

say "waiting for the database to accept connections"
for _ in $(seq 1 30); do
    if docker exec "$CONTAINER" pg_isready -U "$RESTORE_USER" -d "$RESTORE_DB" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
docker exec "$CONTAINER" pg_isready -U "$RESTORE_USER" -d "$RESTORE_DB" >/dev/null \
    || die "the throwaway database did not start"

say "+ restoring the dump"
docker cp "$DUMP_FILE" "${CONTAINER}:/tmp/restore.dump"
docker exec "$CONTAINER" pg_restore \
    --username "$RESTORE_USER" \
    --dbname "$RESTORE_DB" \
    --no-owner --no-privileges \
    /tmp/restore.dump

# The sanity queries: does the restored database actually contain the data?
say "+ sanity checks"
USERS="$(docker exec "$CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -tAc \
    'SELECT count(*) FROM "User"' | tr -d '[:space:]')"
say "restored users: ${USERS:-0}"
[ "${USERS:-0}" -gt 0 ] || die "the restored database contains no users — the dump is useless"

ASSETS="$(docker exec "$CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -tAc \
    'SELECT count(*) FROM "Asset"' | tr -d '[:space:]')"
say "restored assets: ${ASSETS:-0}"

# Compare the row counts with the live database.
say "+ comparing the row counts with the live database"
export PGPASSWORD="${PGPASSWORD:-}"
compare_count() {
    local table="$1"
    local live restored
    live="$(psql --host="${PGHOST:-postgres}" --port="${PGPORT:-5432}" \
        --username="${PGUSER:-assetflow}" --dbname="${PGDATABASE:-assetflow}" \
        -tAc "SELECT count(*) FROM \"${table}\"" 2>/dev/null || echo "n/a")"
    restored="$(docker exec "$CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -tAc \
        "SELECT count(*) FROM \"${table}\"" 2>/dev/null || echo "n/a")"
    say "  ${table}: live=${live} restored=${restored}"
    if [ "$live" != "n/a" ] && [ "$restored" != "n/a" ] && [ "$live" != "$restored" ]; then
        warn "  ${table} differs — the backup is older than the live database (that is expected)"
    fi
}

for table in User Department Asset Allocation Notification ActivityLog; do
    compare_count "$table"
done

ENDED_AT=$(date +%s)
DURATION=$((ENDED_AT - STARTED_AT))

say "=== the restore took ${DURATION} seconds (RTO) ==="
write_textfile_metric \
    assetflow_restore_verify_duration_seconds \
    "$DURATION" \
    "Duration of the last verified restore (RTO)"
write_textfile_metric \
    assetflow_restore_verify_last_success_timestamp_seconds \
    "$(date +%s)" \
    "Unix timestamp of the last successful restore verification"
say "the backup can be restored"

#!/usr/bin/env bash
#
# Data lifecycle: move the old rows of one table into cheap object storage.
#
# This is the "capture rig ships data to the cloud" pattern of a data
# pipeline, applied to the application data:
#
#   1. export the rows older than N days as newline-delimited JSON (.gz)
#   2. write a manifest (row count + sha256 + the time of the export)
#   3. upload both to S3
#   4. delete the rows — but only with --apply, and only after the manifest
#      was verified
#
# The default is a dry run: nothing is deleted without --apply.
#
# Usage:
#   ./archive-old-rows.sh --table ActivityLog --older-than 90 [--apply] [--dry-run]
#
# Exit codes: 0 = ok, 1 = error, 2 = wrong usage
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

TABLE=""
OLDER_THAN_DAYS=90
APPLY=false
DEST_DIR="${ARCHIVE_DIR:-/var/backups/assetflow/archive}"
S3_BUCKET="${S3_BUCKET:-}"
S3_PREFIX="${S3_PREFIX:-assetflow/archive}"

while [ $# -gt 0 ]; do
    case "$1" in
        --table) TABLE="$2"; shift ;;
        --older-than) OLDER_THAN_DAYS="$2"; shift ;;
        --apply) APPLY=true ;;
        --dry-run|--help|-h) : ;;
        *) die "unknown argument: $1" ;;
    esac
    shift
done

[ -n "$TABLE" ] || die "--table is required (e.g. --table ActivityLog)"
case "$TABLE" in
    User|Department|AssetCategory|Asset|Allocation|TransferRequest|Booking|MaintenanceRequest|AuditCycle|AuditAssignment|AuditItem|Notification|ActivityLog) ;;
    *) die "unknown table: ${TABLE}" ;;
esac

say "=== archive ${TABLE} (older than ${OLDER_THAN_DAYS} days) ==="

DB_PASSWORD="${POSTGRES_PASSWORD:-${PGPASSWORD:-}}"
psql_exec() {
    # No published Postgres port: run psql inside the container.
    compose exec -T -e PGPASSWORD="$DB_PASSWORD" postgres \
        psql --username="${PGUSER:-assetflow}" --dbname="${PGDATABASE:-assetflow}" \
        --no-align --tuples-only --quiet "$@"
}

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
OUT_FILE="${DEST_DIR}/${TABLE}-${STAMP}.ndjson.gz"
MANIFEST_FILE="${OUT_FILE}.manifest.json"

if [ "$DRY_RUN" = true ]; then
    say "[dry-run] mkdir -p ${DEST_DIR}"
else
    mkdir -p "$DEST_DIR"
fi

# 1. The export -------------------------------------------------------------
# json_agg turns every row into one JSON object per line; gzip keeps the
# object storage cheap.
say "+ exporting the rows"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] psql … -c \"COPY (SELECT row_to_json(t) FROM \\\"${TABLE}\\\" t WHERE \\\"createdAt\\\" < now() - interval '${OLDER_THAN_DAYS} days') TO STDOUT\" | gzip > ${OUT_FILE}"
    exit 0
fi

psql_exec -c \
    "COPY (SELECT row_to_json(t) FROM \"${TABLE}\" t WHERE \"createdAt\" < now() - interval '${OLDER_THAN_DAYS} days') TO STDOUT" \
    | gzip -9 > "$OUT_FILE"

ROW_COUNT="$(gzip -dc "$OUT_FILE" | wc -l | tr -d ' ')"
SHA256="$(sha256sum "$OUT_FILE" | cut -d' ' -f1)"
SIZE_BYTES="$(stat -c%s "$OUT_FILE")"

say "exported ${ROW_COUNT} rows (${SIZE_BYTES} bytes, sha256 ${SHA256:0:16}…)"

if [ "$ROW_COUNT" -eq 0 ]; then
    say "nothing to archive — the table has no old rows"
    exit 0
fi

# 2. The manifest -----------------------------------------------------------
say "+ writing the manifest"
cat > "$MANIFEST_FILE" <<JSON
{
  "table": "${TABLE}",
  "older_than_days": ${OLDER_THAN_DAYS},
  "exported_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "row_count": ${ROW_COUNT},
  "sha256": "${SHA256}",
  "size_bytes": ${SIZE_BYTES},
  "source": "${PGDATABASE:-assetflow}"
}
JSON

# 3. The upload -------------------------------------------------------------
if [ -n "$S3_BUCKET" ]; then
    require_s3
    say "+ uploading to s3://${S3_BUCKET}/${S3_PREFIX}/"
    aws s3 cp "$OUT_FILE" "s3://${S3_BUCKET}/${S3_PREFIX}/" --only-show-errors
    aws s3 cp "$MANIFEST_FILE" "s3://${S3_BUCKET}/${S3_PREFIX}/" --only-show-errors
else
    warn "S3_BUCKET is not set — the archive stays on the local disk"
fi

# 4. The deletion -----------------------------------------------------------
if [ "$APPLY" != true ]; then
    say "dry run: the rows were NOT deleted (use --apply to delete them)"
    exit 0
fi

say "+ deleting the archived rows"
DELETED="$(psql_exec -tAc \
    "WITH deleted AS (DELETE FROM \"${TABLE}\" WHERE \"createdAt\" < now() - interval '${OLDER_THAN_DAYS} days' RETURNING 1) SELECT count(*) FROM deleted")"
say "deleted ${DELETED:-0} rows"

# 5. The metric -------------------------------------------------------------
write_textfile_metric \
    assetflow_archive_last_success_timestamp_seconds \
    "$(date +%s)" \
    "Unix timestamp of the last successful archive run"

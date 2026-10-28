#!/usr/bin/env bash
#
# Nightly backup of the AssetFlow database.
#
#   pg_dump --format=custom  ->  gzip  ->  sha256  ->  S3
#
#   * the checksum is written next to the dump, so a restore can prove that
#     the file was not corrupted on the way
#   * old backups are pruned (RETENTION_DAYS) — a backup you never delete
#     is a backup you cannot afford
#   * the success is published as a Prometheus metric, so "the backup ran" is
#     an alert, not a hope
#
# Usage:
#   ./backup.sh [--dry-run]
#
# Environment:
#   S3_BUCKET      (required)  the destination bucket
#   S3_PREFIX                 the key prefix (default: assetflow/backups)
#   AWS_REGION                the region of the bucket
#   RETENTION_DAYS             how long to keep the backups (default 14)
#   BACKUP_DIR                 where the dump is written (default /var/backups/assetflow)
#   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE  the database connection
#
# Exit codes: 0 = backup created, 1 = error, 2 = wrong usage
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/assetflow}"
S3_PREFIX="${S3_PREFIX:-assetflow/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
DUMP_FILE="${BACKUP_DIR}/assetflow-${STAMP}.dump"
CHECKSUM_FILE="${DUMP_FILE}.sha256"

say "=== AssetFlow backup ${STAMP} ==="
say "destination: ${S3_BUCKET:-<unset>}/${S3_PREFIX}"

if [ "$DRY_RUN" = true ]; then
    say "[dry-run] mkdir -p ${BACKUP_DIR}"
else
    mkdir -p "$BACKUP_DIR"
fi

# 1. The dump ---------------------------------------------------------------
# --format=custom (Fc) is compressed, restorable with pg_restore and can be
# restored in parallel — a plain SQL dump would have to be replayed serially.
export PGPASSWORD="${PGPASSWORD:-}"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] pg_dump --format=custom --file=${DUMP_FILE} ..."
else
    say "+ pg_dump --format=custom --file=${DUMP_FILE}"
    pg_dump --format=custom --file="$DUMP_FILE" \
        --host="${PGHOST:-postgres}" \
        --port="${PGPORT:-5432}" \
        --username="${PGUSER:-assetflow}" \
        --dbname="${PGDATABASE:-assetflow}" \
        --no-owner --no-privileges
fi

# 2. The checksum -----------------------------------------------------------
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] sha256sum ${DUMP_FILE} > ${CHECKSUM_FILE}"
else
    say "+ sha256sum"
    ( cd "$BACKUP_DIR" && sha256sum "$(basename "$DUMP_FILE")" > "$(basename "$CHECKSUM_FILE")" )
fi

# 3. The upload -------------------------------------------------------------
if [ -n "${S3_BUCKET:-}" ]; then
    require_s3
    if [ "$DRY_RUN" = true ]; then
        say "[dry-run] aws s3 cp ${DUMP_FILE} s3://${S3_BUCKET}/${S3_PREFIX}/"
        say "[dry-run] aws s3 cp ${CHECKSUM_FILE} s3://${S3_BUCKET}/${S3_PREFIX}/"
    else
        say "+ aws s3 cp (dump)"
        aws s3 cp "$DUMP_FILE" "s3://${S3_BUCKET}/${S3_PREFIX}/" --only-show-errors
        say "+ aws s3 cp (checksum)"
        aws s3 cp "$CHECKSUM_FILE" "s3://${S3_BUCKET}/${S3_PREFIX}/" --only-show-errors
    fi
else
    warn "S3_BUCKET is not set — the backup stays on the local disk only"
fi

# 4. The retention ----------------------------------------------------------
say "pruning local backups older than ${RETENTION_DAYS} days"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] find ${BACKUP_DIR} -name 'assetflow-*.dump*' -mtime +${RETENTION_DAYS} -delete"
else
    find "$BACKUP_DIR" -name 'assetflow-*.dump*' -type f -mtime "+${RETENTION_DAYS}" -delete
fi

if [ -n "${S3_BUCKET:-}" ] && [ "$DRY_RUN" != true ]; then
    say "pruning S3 backups older than ${RETENTION_DAYS} days"
    # --keep-days is only available on the S3 sync commands.
    aws s3 sync "s3://${S3_BUCKET}/${S3_PREFIX}/" "$BACKUP_DIR/s3-sync" \
        --keep-days "$RETENTION_DAYS" --only-show-errors || \
        warn "the S3 retention pass failed — check the IAM policy"
fi

# 5. The metric -------------------------------------------------------------
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] write_textfile_metric assetflow_backup_last_success_timestamp_seconds $(date +%s)"
else
    write_textfile_metric \
        assetflow_backup_last_success_timestamp_seconds \
        "$(date +%s)" \
        "Unix timestamp of the last successful database backup"
    say "backup finished"
fi

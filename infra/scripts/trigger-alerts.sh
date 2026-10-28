#!/usr/bin/env bash
#
# Fires the alerts on purpose — an alert you never triggered is an alert you
# do not know works.
#
# Usage:
#   ./trigger-alerts.sh [api|backup|disk|all] [--dry-run]
#
# Exit codes: 0 = ok, 1 = error
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

WHAT="${1:-all}"
# A flag is not a target.
case "$WHAT" in
    -*) WHAT=all ;;
esac
TEXTFILE_DIR="${TEXTFILE_DIR:-${INFRA_DIR}/textfile}"

restore() {
    if [ "$DRY_RUN" = true ]; then return; fi
    say "→ cleaning up"
    compose up -d api >/dev/null 2>&1 || true
    rm -f "${TEXTFILE_DIR}/assetflow_backup_last_success_timestamp_seconds.prom" 2>/dev/null || true
    rm -f /var/lib/assetflow/disk-fill-test.bin 2>/dev/null || true
    say "  done"
}
trap restore EXIT

# Stops the API → the 'AssetflowApiDown' rule fires.
trigger_api() {
    say "→ stopping the API container — expect 'AssetflowApiDown'"
    if [ "$DRY_RUN" = true ]; then
        say "[dry-run] compose stop api"
        return 0
    fi
    compose stop api
    sleep 60
}

# Pretends the last backup is three days old → the 'BackupTooOld' rule fires.
trigger_backup() {
    say "→ pretending the last backup was three days ago — expect 'BackupTooOld'"
    if [ "$DRY_RUN" = true ]; then
        say "[dry-run] write_textfile_metric assetflow_backup_last_success_timestamp_seconds <3 days ago>"
        return 0
    fi
    write_textfile_metric \
        assetflow_backup_last_success_timestamp_seconds \
        "$(( $(date +%s) - 259200 ))" \
        "Unix timestamp of the last successful database backup"
    sleep 60
}

# Fills the disk → the 'HostDiskAlmostFull' rule fires.
trigger_disk() {
    say "→ filling the disk — expect 'HostDiskAlmostFull'"
    if [ "$DRY_RUN" = true ]; then
        say "[dry-run] fallocate -l 512M /var/lib/assetflow/disk-fill-test.bin"
        return 0
    fi
    mkdir -p /var/lib/assetflow
    # 512 MB — enough to trip the 85% rule on a 20 GB volume, small enough to
    # be harmless.
    fallocate -l 512M /var/lib/assetflow/disk-fill-test.bin 2>/dev/null \
        || dd if=/dev/zero of=/var/lib/assetflow/disk-fill-test.bin bs=1M count=512
    sleep 60
}

case "$WHAT" in
    api) trigger_api ;;
    backup) trigger_backup ;;
    disk) trigger_disk ;;
    all)
        trigger_api
        trigger_backup
        trigger_disk
        ;;
    *)
        die "unknown target: ${WHAT} (use api, backup, disk or all)"
        ;;
esac

say "the alert should have arrived in Telegram within a minute"

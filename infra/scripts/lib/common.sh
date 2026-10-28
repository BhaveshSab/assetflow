#!/usr/bin/env bash
#
# Shared helpers for the AssetFlow operations scripts.
#
# Sourced by every script in this directory:
#   source "$(dirname "$0")/lib/common.sh"
#
# Every script follows the same rules:
#   * `set -euo pipefail` — a failed command stops the script
#   * idempotent — running it twice changes nothing the second time
#   * `--dry-run` — prints what it would do, changes nothing
#   * timestamped log lines, a log file per run
#   * meaningful exit codes (0 = ok, 1 = error, 2 = usage error)

set -euo pipefail

# --------------------------------------------------------------- logging ----
LOG_FILE="${LOG_FILE:-}"

log()  { printf '%s [INFO] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
warn() { printf '%s [WARN] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
die()  { printf '%s [FAIL] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; exit 1; }

usage() {
    printf 'Usage: %s [--dry-run] [--help]\n' "$(basename "$0")" >&2
    exit 2
}

# Starts the log file (one per run) and the common flags.
init_script() {
    # Read by the scripts that source this library.
    # shellcheck disable=SC2034
    DRY_RUN=false
    while [ $# -gt 0 ]; do
        case "$1" in
            --dry-run) DRY_RUN=true ;;
            --help|-h) usage ;;
            # The calling script parses its own arguments — an unknown one is
            # reported there, not here.
            *) : ;;
        esac
        shift
    done

    if [ -z "${LOG_FILE:-}" ]; then
        LOG_DIR="${LOG_DIR:-/var/log/assetflow}"
        mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="$(mktemp -d)"
        LOG_FILE="${LOG_DIR}/$(basename "$0" .sh)-$(date -u '+%Y%m%dT%H%M%SZ').log"
        # The log must never be the reason a script fails.
        touch "$LOG_FILE" 2>/dev/null || LOG_FILE=""
    fi
}

# Writes a line to stdout *and* to the log file.
say() {
    printf '%s\n' "$*"
    if [ -n "${LOG_FILE:-}" ]; then
        printf '%s\n' "$*" >> "$LOG_FILE"
    fi
}

# The directory of the repository (two levels up from this file).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INFRA_DIR="${REPO_ROOT}/infra"

# The compose project — the same files on the laptop and on the server.
compose() {
    if docker compose version >/dev/null 2>&1; then
        docker compose --project-directory "$INFRA_DIR" -f "$INFRA_DIR/docker-compose.yml" "$@"
    else
        docker-compose --project-directory "$INFRA_DIR" -f "$INFRA_DIR/docker-compose.yml" "$@"
    fi
}

# The same, with the local override (extra published ports).
compose_local() {
    if docker compose version >/dev/null 2>&1; then
        docker compose --project-directory "$INFRA_DIR" \
            -f "$INFRA_DIR/docker-compose.yml" \
            -f "$INFRA_DIR/docker-compose.local.yml" "$@"
    else
        docker-compose --project-directory "$INFRA_DIR" \
            -f "$INFRA_DIR/docker-compose.yml" \
            -f "$INFRA_DIR/docker-compose.local.yml" "$@"
    fi
}

# Writes a metric for the node_exporter textfile collector.
# The value is read by Prometheus as `assetflow_backup_last_success_timestamp_seconds`.
write_textfile_metric() {
    local name="$1" value="$2" help="$3"
    local dir="${TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
    mkdir -p "$dir" 2>/dev/null || return 0
    {
        printf '# HELP %s %s\n' "$name" "$help"
        printf '# TYPE %s gauge\n' "$name"
        printf '%s %s\n' "$name" "$value"
    } > "${dir}/${name}.prom"
}

# The S3 destination of the backups.
require_s3() {
    [ -n "${S3_BUCKET:-}" ] || die "S3_BUCKET is not set — where should the backup go?"
    command -v aws >/dev/null 2>&1 || die "the AWS CLI is not installed (apt install awscli)"
}

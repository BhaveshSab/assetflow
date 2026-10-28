#!/usr/bin/env bash
#
# Proves the alert path — an alert that was never delivered is an alert you
# do not know works.
#
# This injects a *synthetic* alert with the same name/labels as a real rule
# directly into Alertmanager. That tests the part people skip: routing,
# grouping, the Telegram receiver and the credentials. It does not wait for
# Prometheus to evaluate a rule (the rules use for: 2m–15m on purpose).
#
# Usage:
#   ./trigger-alerts.sh [api|backup|disk|all] [--dry-run]
#
# Exit codes: 0 = the alert was accepted, 1 = error
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

WHAT="${1:-all}"
case "$WHAT" in
    -*) WHAT=all ;;
esac
ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://127.0.0.1:9093}"
WAIT_SECONDS="${WAIT_SECONDS:-45}"

alert_payload() {
    local name="$1" summary="$2" description="$3" ends_at="$4"
    cat <<EOF
[{
  "labels": {
    "alertname": "${name}",
    "severity": "critical",
    "service": "assetflow",
    "instance": "manual-test"
  },
  "annotations": {
    "summary": "${summary}",
    "description": "${description}",
    "runbook": "docs/RUNBOOK.md"
  },
  "startsAt": "$(date -u -d '-2 minutes' '+%Y-%m-%dT%H:%M:%SZ')",
  "endsAt": "${ends_at}",
  "generatorURL": "https://github.com/BhaveshSab/assetflow"
}]
EOF
}

post() {
    local payload="$1"
    if [ "$DRY_RUN" = true ]; then
        say "[dry-run] POST ${ALERTMANAGER_URL}/api/v2/alerts"
        printf '%s\n' "$payload"
        return 0
    fi
    curl -fsS -X POST "${ALERTMANAGER_URL}/api/v2/alerts" \
        -H 'Content-Type: application/json' \
        --data-binary "$payload" >/dev/null
}

deliver() {
    local name="$1" summary="$2" description="$3"
    local future past
    future="$(date -u -d '+5 minutes' '+%Y-%m-%dT%H:%M:%SZ')"
    past="$(date -u -d '-1 minute' '+%Y-%m-%dT%H:%M:%SZ')"

    say "→ injecting ${name} — expect a Telegram message"
    post "$(alert_payload "$name" "$summary" "$description" "$future")"
}

case "$WHAT" in
    api)
        deliver "AssetflowApiDown" \
            "The AssetFlow API does not answer" \
            "Synthetic delivery test: the API-down alert."
        ;;
    backup)
        deliver "BackupTooOld" \
            "The last successful backup is older than 26 hours" \
            "Synthetic delivery test: the backup-age alert."
        ;;
    disk)
        deliver "HostDiskAlmostFull" \
            "The disk is more than 85% full" \
            "Synthetic delivery test: the disk alert."
        ;;
    all)
        deliver "AssetflowApiDown" \
            "The AssetFlow API does not answer" \
            "Synthetic delivery test: the API-down alert."
        deliver "BackupTooOld" \
            "The last successful backup is older than 26 hours" \
            "Synthetic delivery test: the backup-age alert."
        deliver "HostDiskAlmostFull" \
            "The disk is more than 85% full" \
            "Synthetic delivery test: the disk alert."
        ;;
    *)
        die "unknown target: ${WHAT} (use api, backup, disk or all)"
        ;;
esac

if [ "$DRY_RUN" = true ]; then
    say "[dry-run] waiting ${WAIT_SECONDS}s for Alertmanager → Telegram"
    say "[dry-run] then resolving the alert"
    exit 0
fi

say "waiting ${WAIT_SECONDS}s for Alertmanager → Telegram…"
sleep "$WAIT_SECONDS"

# Resolve every injected alert (send_resolved: true shows a green message).
future="$(date -u -d '+5 minutes' '+%Y-%m-%dT%H:%M:%SZ')"
past="$(date -u -d '-1 minute' '+%Y-%m-%dT%H:%M:%SZ')"
case "$WHAT" in
    api|all)
        post "$(alert_payload "AssetflowApiDown" "resolved" "The delivery test is complete." "$past")" ;;
esac
case "$WHAT" in
    backup|all)
        post "$(alert_payload "BackupTooOld" "resolved" "The delivery test is complete." "$past")" ;;
esac
case "$WHAT" in
    disk|all)
        post "$(alert_payload "HostDiskAlmostFull" "resolved" "The delivery test is complete." "$past")" ;;
esac

say "the alerts were sent to Alertmanager; check the Telegram chat and:"
say "  docker compose -f infra/docker-compose.yml logs --tail 30 alertmanager"

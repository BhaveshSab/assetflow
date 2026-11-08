#!/usr/bin/env bash
# Validate every supported Compose variant without hiding failure output under
# GitHub's bash -e. Run with an existing infra/.env (CI copies .env.example).
set -euo pipefail
cd "$(dirname "$0")/../.."
status=0
check_config() {
    local output code detail
    if output=$(docker compose "$@" config --quiet 2>&1); then
        printf 'Compose configuration passed: %s\n' "$*"
    else
        code=$?
        status=1
        printf '%s\n' "$output"
        # One actionable annotation, rather than one annotation per log line.
        detail=${output//'%'/'%25'}
        detail=${detail//$'\r'/'%0D'}
        detail=${detail//$'\n'/'%0A'}
        printf '::error title=compose::docker compose %s config failed (exit %s): %s\n' "$*" "$code" "$detail"
    fi
}
check_config -f infra/docker-compose.yml
check_config -f infra/docker-compose.yml -f infra/docker-compose.local.yml
check_config --profile jobs -f infra/docker-compose.yml
exit "$status"

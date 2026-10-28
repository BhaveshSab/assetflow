#!/usr/bin/env bash
#
# Deploys a new version of the API to the server and rolls back when it does
# not become healthy.
#
#   pull the image  ->  run the migrations  ->  start the new container
#                    ->  health check  ->  rollback on failure
#
# Usage:
#   ./deploy.sh [--dry-run]
#
# Environment:
#   IMAGE        the image to deploy (default ghcr.io/bhaveshsab/assetflow-api:latest)
#   HEALTH_URL   the readiness endpoint (default http://127.0.0.1/api/health/ready)
#   HEALTH_RETRIES  how often the check is repeated (default 10)
#
# Exit codes: 0 = deployed, 1 = the deployment failed (and was rolled back)
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

IMAGE="${IMAGE:-ghcr.io/bhaveshsab/assetflow-api:latest}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1/api/health/ready}"
HEALTH_RETRIES="${HEALTH_RETRIES:-10}"
PREVIOUS_IMAGE_FILE="/var/lib/assetflow/previous-image"

say "=== deploying ${IMAGE} ==="

# 1. The image --------------------------------------------------------------
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] docker pull ${IMAGE}"
else
    say "+ docker pull ${IMAGE}"
    docker pull "$IMAGE"
fi

# Remember the running image — that is what we roll back to.
if [ "$DRY_RUN" != true ]; then
    mkdir -p "$(dirname "$PREVIOUS_IMAGE_FILE")"
    CURRENT="$(compose ps -q api 2>/dev/null | xargs -r docker inspect --format '{{.Config.Image}}' 2>/dev/null || true)"
    if [ -n "$CURRENT" ] && [ -f "$PREVIOUS_IMAGE_FILE" ]; then
        cp "$PREVIOUS_IMAGE_FILE" "${PREVIOUS_IMAGE_FILE}.tmp"
        echo "$CURRENT" > "${PREVIOUS_IMAGE_FILE}.tmp"
        mv "${PREVIOUS_IMAGE_FILE}.tmp" "$PREVIOUS_IMAGE_FILE"
    elif [ -n "$CURRENT" ]; then
        echo "$CURRENT" > "$PREVIOUS_IMAGE_FILE"
    fi
    say "  the image in use before the deployment: ${CURRENT:-<none>}"
fi

# 2. The migrations ---------------------------------------------------------
say "+ applying the migrations (one-shot container)"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] compose run --rm migrate"
else
    IMAGE_TAG="$IMAGE" compose run --rm migrate
fi

# 3. The new container ------------------------------------------------------
say "+ starting the new version"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] compose up -d api"
else
    compose up -d --no-deps api
fi

# 4. The health check -------------------------------------------------------
say "+ health check (${HEALTH_URL})"
HEALTHY=false
for attempt in $(seq 1 "$HEALTH_RETRIES"); do
    if [ "$DRY_RUN" = true ]; then
        HEALTHY=true
        break
    fi
    sleep 5
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
        HEALTHY=true
        say "  healthy after ${attempt} attempt(s)"
        break
    fi
    say "  attempt ${attempt}/${HEALTH_RETRIES} — not ready yet"
done

if [ "$HEALTHY" != true ]; then
    warn "the new version did not become healthy — rolling back"
    if [ -f "$PREVIOUS_IMAGE_FILE" ] && [ "$DRY_RUN" != true ]; then
        PREVIOUS="$(cat "$PREVIOUS_IMAGE_FILE")"
        say "+ rolling back to ${PREVIOUS}"
        IMAGE="$PREVIOUS" compose up -d --no-deps api
    else
        say "+ no previous image known — the old container stays as it is"
    fi
    compose logs --tail 50 api || true
    exit 1
fi

say "=== the deployment succeeded ==="

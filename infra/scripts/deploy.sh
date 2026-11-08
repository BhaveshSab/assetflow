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
#   MIGRATE_IMAGE migration image from the same commit (derived from IMAGE)
#   WEB_IMAGE    optional prebuilt web image (workflow activates it afterwards)
#   HEALTH_URL   the readiness endpoint (default http://127.0.0.1/api/health/ready)
#   HEALTH_RETRIES  how often the check is repeated (default 10)
#
# Exit codes: 0 = deployed, 1 = the deployment failed (and was rolled back)
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
# Host .env supplies defaults, but must not override explicit release pins.
requested_image="${IMAGE:-}"
requested_migrate_image="${MIGRATE_IMAGE:-}"
requested_web_image="${WEB_IMAGE:-}"
init_script "$@"

IMAGE="${requested_image:-${IMAGE:-ghcr.io/bhaveshsab/assetflow-api:latest}}"
MIGRATE_IMAGE="${requested_migrate_image:-${MIGRATE_IMAGE:-}}"
WEB_IMAGE="${requested_web_image:-${WEB_IMAGE:-}}"
# The migration image is built from the same commit, so its tag must match:
#   …/assetflow-api:abc123  ->  …/assetflow-migrate:abc123
# Any other image name keeps the compose default (or an explicit override).
if [ -z "${MIGRATE_IMAGE:-}" ]; then
    case "$IMAGE" in
        *-api:*) MIGRATE_IMAGE="${IMAGE%-api:*}-migrate:${IMAGE##*:}" ;;
        *) MIGRATE_IMAGE="ghcr.io/bhaveshsab/assetflow-migrate:latest" ;;
    esac
fi
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1/api/health/ready}"
HEALTH_RETRIES="${HEALTH_RETRIES:-10}"
# The image that was running before this deployment. It has to be writable by
# the deploy user — the GitHub workflow connects as an ordinary account, not
# as root — so it defaults to a per-user state directory.
PREVIOUS_IMAGE_FILE="${PREVIOUS_IMAGE_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/assetflow/previous-image}"

say "=== deploying ${IMAGE} ==="

# The image running right now is what a failed deploy rolls back to. Read it
# first, before anything can remove it.
CURRENT=""
PREVIOUS=""
if [ "$DRY_RUN" != true ]; then
    mkdir -p "$(dirname "$PREVIOUS_IMAGE_FILE")"
    CURRENT="$(compose ps -q api 2>/dev/null | xargs -r docker inspect --format '{{.Config.Image}}' 2>/dev/null || true)"
    if [ -n "$CURRENT" ]; then
        # The file always holds the image that is running *before* the new one
        # starts, so a second failed deployment still rolls back to the last
        # version that was actually healthy.
        echo "$CURRENT" > "${PREVIOUS_IMAGE_FILE}.tmp"
        mv "${PREVIOUS_IMAGE_FILE}.tmp" "$PREVIOUS_IMAGE_FILE"
    fi
    PREVIOUS="$(cat "$PREVIOUS_IMAGE_FILE" 2>/dev/null || true)"
    say "  the image in use before the deployment: ${CURRENT:-<none>}"
fi

# Drop the `:<sha>` tags left by previous releases. Keep exactly three things:
# the image running now, the image a rollback would restore, and the image
# being deployed. Everything else is a previous release that nothing can use.
reclaim_superseded_images() {
    {
        docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
            | grep -E 'assetflow-(api|migrate):' \
            | grep -v -F -e "$IMAGE" -e "$MIGRATE_IMAGE" \
            | { if [ -n "$CURRENT" ]; then grep -v -F -e "$CURRENT" || true; else cat; fi; } \
            | { if [ -n "$PREVIOUS" ]; then grep -v -F -e "$PREVIOUS" || true; else cat; fi; } \
            | while read -r image_ref; do
                docker rmi "$image_ref" >/dev/null 2>&1 || true
                say "  removed ${image_ref}"
            done
    } || true
}

# 0. Disk space ---------------------------------------------------------------
# Unpacking an image needs room roughly equal to its uncompressed size, and a
# pull that runs out of space fails halfway through a layer *and* leaves the
# partial snapshot behind — so the next attempt starts with even less. This
# check has to happen before the pull, with a message a human can act on.
#
# It is not hypothetical: a deploy failed with "no space left on device" while
# extracting node_modules from the API image, which is invisible from the job
# log unless you know to look for the containerd error.
MIN_FREE_MB="${MIN_FREE_MB:-1536}"

available_mb() { df -Pm / | awk 'NR==2 {print $4}'; }

say "=== disk before the pull: $(df -Ph / | awk 'NR==2 {print $3 " used of " $2 " (" $5 ")"}') ==="
if [ "$DRY_RUN" != true ]; then
    free_before="$(available_mb)"
    if [ "${free_before:-0}" -lt "$MIN_FREE_MB" ]; then
        say "  ${free_before} MB free < ${MIN_FREE_MB} MB — reclaiming what is safe to reclaim"
        # Least destructive first: stopped containers, then images no tag
        # points at, then build cache older than a week.
        docker container prune -f >/dev/null 2>&1 || true
        docker image prune -f >/dev/null 2>&1 || true
        docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
        # Then the previous releases, which are the bulk of it: every deploy
        # adds a tag and nothing used to remove the old ones.
        reclaim_superseded_images
        free_after="$(available_mb)"
        say "  ${free_after} MB free after the cleanup"

        if [ "${free_after:-0}" -lt "$MIN_FREE_MB" ]; then
            warn "not enough space to deploy safely: ${free_after} MB free, ${MIN_FREE_MB} MB needed"
            say "  the images on this host:"
            docker images --format '  {{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}' 2>/dev/null | head -15 || true
            say "  the largest directories in /var/lib/docker:"
            du -sh /var/lib/docker/* 2>/dev/null | sort -rh | head -5 || true
            say "  free space with: docker system prune -af --filter until=24h"
            say "  (that also removes the rollback image, so the next deploy has nothing to fall back to)"
            exit 2
        fi
    else
        say "  ${free_before} MB free"
    fi
fi

# 1. The image --------------------------------------------------------------
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] docker pull ${IMAGE}"
    say "[dry-run] docker pull ${MIGRATE_IMAGE}"
    [ -z "${WEB_IMAGE:-}" ] || say "[dry-run] docker pull ${WEB_IMAGE}"
else
    say "+ docker pull ${IMAGE}"
    docker pull "$IMAGE"
    say "+ docker pull ${MIGRATE_IMAGE}"
    docker pull "$MIGRATE_IMAGE"
    if [ -n "${WEB_IMAGE:-}" ]; then
        say "+ docker pull ${WEB_IMAGE}"
        docker pull "$WEB_IMAGE"
    fi
fi

# 2. The migrations ---------------------------------------------------------
say "+ applying the migrations (one-shot container)"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] MIGRATE_IMAGE=${MIGRATE_IMAGE} compose run --rm -T migrate"
else
    # -T disables the pseudo-TTY, NOT stdin. Detach stdin explicitly so
    # children cannot consume commands when a caller uses `ssh ... bash -s`.
    #
    # No --no-build and no --pull here, deliberately:
    #   * `docker compose run` has no --no-build (it belongs to `up`); passing
    #     it aborted every deployment with "unknown flag: --no-build" before
    #     the migration and before the new container ever started.
    #   * `run --pull` only exists on newer Compose plugins, and the host's
    #     version is not pinned by this repository. The image is already local:
    #     step 1 pulled it under its exact commit tag and MIGRATE_IMAGE carries
    #     that tag, so compose has nothing to build and no `latest` to fetch.
    # This is the same invocation provision-host.sh uses on the same host.
    MIGRATE_IMAGE="$MIGRATE_IMAGE" compose run --rm -T migrate </dev/null
fi

# 3. The new container ------------------------------------------------------
say "+ starting the new version"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] API_IMAGE=${IMAGE} compose up -d --no-deps --no-build --pull never api"
else
    # The compose file reads API_IMAGE; without it, compose would start the
    # `latest` tag and the deployment would silently ignore $IMAGE.
    API_IMAGE="$IMAGE" compose up -d --no-deps --no-build --pull never api
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
    # Require a literal 200. `curl -f` alone also accepts a 301, so a
    # HTTP→HTTPS redirect would report a dead API as healthy.
    STATUS="$(curl -skS -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
    if [ "$STATUS" = "200" ]; then
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
        API_IMAGE="$PREVIOUS" compose up -d --no-deps --no-build --pull never api
    else
        say "+ no previous image known — the old container stays as it is"
    fi
    compose logs --tail 50 api || true
    exit 1
fi

# The worker uses the exact API tag and is explicitly opt-in. Do not run it
# alongside the legacy booking sweeper when the flag is disabled.
if [ "${JOBS_ENABLED:-false}" = true ]; then
    say "+ reconciling the booking worker and dedicated queue Redis"
    if [ "$DRY_RUN" = true ]; then
        say "[dry-run] API_IMAGE=${IMAGE} compose --profile jobs up -d --no-deps --no-build --wait jobs-redis worker"
    else
        API_IMAGE="$IMAGE" compose --profile jobs up -d --no-deps --no-build --wait --wait-timeout 90 jobs-redis worker
    fi
else
    if [ "$DRY_RUN" != true ]; then
        compose --profile jobs stop worker
    fi
fi

# Monitoring config is shipped with the checkout, not the API image. Reconcile
# these services explicitly or a successful API deploy leaves the new exporters
# absent and Prometheus using its old mounts/configuration.
say "+ reconciling monitoring services"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] compose up -d --no-deps --no-build cadvisor blackbox prometheus alertmanager"
else
    compose up -d --no-deps --no-build cadvisor blackbox prometheus alertmanager
    # Bind-mounted config content changes do not always recreate a container.
    # Reload via the internal network, not a publicly exposed lifecycle port.
    reloaded=false
    for attempt in $(seq 1 15); do
        if compose exec -T prometheus wget -qO- --post-data='' http://127.0.0.1:9090/-/reload </dev/null; then
            reloaded=true
            break
        fi
        sleep 2
    done
    if [ "$reloaded" != true ]; then
        warn "API is healthy, but Prometheus did not reload; inspect monitoring logs"
        compose logs --tail 30 prometheus cadvisor blackbox alertmanager || true
        exit 1
    fi
fi

# 5. Reclaim the superseded images -------------------------------------------
# Every deployment adds a `:<sha>` tag. Keeping them all is what filled the disk
# and broke a deployment, so the old ones go now that the new image is healthy.
if [ "$DRY_RUN" != true ]; then
    say "+ removing the images that are neither running nor the rollback target"
    reclaim_superseded_images
    say "  disk after the deploy: $(df -Ph / | awk 'NR==2 {print $3 " used of " $2 " (" $5 ")"}')"
fi

say "=== the deployment succeeded ==="

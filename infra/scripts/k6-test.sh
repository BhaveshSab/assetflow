#!/usr/bin/env bash
#
# Runs the AssetFlow load test and keeps the raw output for the resume
# evidence (docs/results/).
#
# Usage:
#   ./k6-test.sh [--dry-run]
#
# Environment:
#   BASE_URL   the API origin, without /api (default: http://localhost:8080)
#   VUS        virtual users (default: 25)
#   DURATION   how long the test runs (default: 3m)
#   EMAIL / PASSWORD  the demo account (default: the seeded admin)
#
# If k6 is not installed, the official container is used (Linux hosts only).
#
# Exit codes: 0 = all thresholds passed, 1 = the test failed or k6 is missing
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

BASE_URL="${BASE_URL:-http://localhost:8080}"
VUS="${VUS:-25}"
DURATION="${DURATION:-3m}"
EMAIL="${EMAIL:-admin@assetflow.com}"
PASSWORD="${PASSWORD:-password123}"
RESULTS_DIR="${REPO_ROOT}/docs/results"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
OUT="${RESULTS_DIR}/k6-${STAMP}.log"

say "=== AssetFlow load test ==="
say "target:   ${BASE_URL}"
say "users:    ${VUS} for ${DURATION}"
say "output:   ${OUT}"

if [ "$DRY_RUN" = true ]; then
    say "[dry-run] k6 run -e BASE_URL=${BASE_URL} -e VUS=${VUS} -e DURATION=${DURATION} infra/scripts/k6-load.js"
    exit 0
fi

mkdir -p "$RESULTS_DIR"

if command -v k6 >/dev/null 2>&1; then
    K6=(k6)
else
    command -v docker >/dev/null 2>&1 || die "k6 is not installed and Docker is unavailable (https://k6.io/docs/get-started/installation/)"
    say "k6 is not installed — using the grafana/k6 container"
    K6=(docker run --rm --network host -v "${REPO_ROOT}:/work" -w /work grafana/k6)
fi

# `pipefail` is already set: a failing k6 exits non-zero even through tee.
"${K6[@]}" run \
    -e BASE_URL="$BASE_URL" \
    -e VUS="$VUS" \
    -e DURATION="$DURATION" \
    -e EMAIL="$EMAIL" \
    -e PASSWORD="$PASSWORD" \
    "${REPO_ROOT}/infra/scripts/k6-load.js" | tee "$OUT"

say "raw output saved to ${OUT}"

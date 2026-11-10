#!/usr/bin/env bash
#
# The single fixture-seeding path, shared by the EC2 bootstrap and CI.
#
# Why this exists: CI and the bootstrap used to run two separate commands that
# looked identical. They were not the same deployment — CI built the images
# explicitly, the bootstrap did not, so a real run pulled a prebuilt migrate
# image, applied no migrations, and failed seeding 37 seconds later against a
# schema that did not match the code. Nothing in either command said
# "build first". One shared script makes that divergence inexpressible.
#
# Usage
#   seed-fixtures.sh --run-id <id> [--users N] [--evidence-dir DIR] [--quiet]
#
# Environment
#   LOADTEST_PASSWORD   required: the seed refuses more than one account without it
#   COMPOSE             optional: defaults to the standard three-part invocation
#
# Exit status
#   0  accounts were created AND verified by database query
#   1  the seed failed
#   2  usage or precondition problem
set -euo pipefail

RUN_ID=""
USERS="200"
EVIDENCE_DIR=""
QUIET=0

while [ $# -gt 0 ]; do
    case "$1" in
        --run-id) RUN_ID="${2:?--run-id needs a value}"; shift 2 ;;
        --users) USERS="${2:?--users needs a value}"; shift 2 ;;
        --evidence-dir) EVIDENCE_DIR="${2:?--evidence-dir needs a value}"; shift 2 ;;
        --quiet) QUIET=1; shift ;;
        *) echo "seed-fixtures: unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$RUN_ID" ] || { echo "seed-fixtures: --run-id is required" >&2; exit 2; }
case "$USERS" in
    ''|*[!0-9]*) echo "seed-fixtures: --users must be a positive integer, got '$USERS'" >&2; exit 2 ;;
esac

# The seed accepts 1 account without a password, so a missing password would
# silently produce accounts nobody can sign in as. Refuse instead.
if [ "$USERS" -gt 1 ] && [ -z "${LOADTEST_PASSWORD:-}" ]; then
    echo "seed-fixtures: LOADTEST_PASSWORD is required for more than one account" >&2
    exit 2
fi

COMPOSE="${COMPOSE:-docker compose --env-file infra/.env -f infra/docker-compose.yml}"
SEED_LOG="$(mktemp)"
trap 'rm -f "$SEED_LOG"' EXIT

say() { [ "$QUIET" -eq 1 ] || printf '[fixtures] %s\n' "$*"; }

# Report a bounded, redacted summary. The raw log is kept by the caller when it
# wants to; this output is what reaches a console or a CI log, so it must never
# carry a password, a connection string with a password, or a token.
redact() {
    sed -E \
        -e 's#(postgres(ql)?://)[^@/[:space:]]+@#\1***@#g' \
        -e 's/(password|PASSWORD|passwd|secret|SECRET|token|TOKEN)[=:][^[:space:]",}]*/\1=***/g' \
        -e 's/(Bearer )[A-Za-z0-9._-]+/\1***/g' \
        -e 's/("passwordHash"[[:space:]]*:[[:space:]]*")[^"]*/\1***/g' \
        "$1"
}

# Bounded: the last lines are where a failure explains itself, the first are
# where a missing module or bad argument appears.
summarise() {
    local file="$1"
    {
        echo "--- seed output: first 25 lines ---"
        redact "$file" | head -25
        echo "--- seed output: last 25 lines ---"
        redact "$file" | tail -25
    }
}

say "seeding $USERS account(s) for run $RUN_ID"

rc=0
# --no-deps: postgres is already up and healthy from the migrate step. Letting
# this re-create it would reset the schema underneath the fixtures.
# TS_NODE_TRANSPILE_ONLY: the seed is executed, not type-checked.
$COMPOSE run --rm --no-deps \
    -e TS_NODE_TRANSPILE_ONLY=true \
    -e LOADTEST_PASSWORD="${LOADTEST_PASSWORD:-}" \
    migrate npm run seed:loadtest -- --run-id "$RUN_ID" --users "$USERS" \
    > "$SEED_LOG" 2>&1 || rc=$?

if [ "$rc" -ne 0 ]; then
    echo "seed-fixtures: seeding failed with exit $rc"
    summarise "$SEED_LOG"
    if [ -n "$EVIDENCE_DIR" ]; then
        mkdir -p "$EVIDENCE_DIR"
        mv "$SEED_LOG" "$EVIDENCE_DIR/seed.log"
        say "raw log kept at $EVIDENCE_DIR/seed.log"
    fi
    exit 1
fi

# A count alone does not show every account can sign in. Require a stored hash,
# so a fixture with no password cannot pass as ready.
SEEDED="$($COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-assetflow}" \
    -d "${POSTGRES_DB:-assetflow}" -tAc \
    "SELECT count(*) FROM \"User\" WHERE email LIKE 'loadtest-${RUN_ID}-%@assetflow.test'" \
    2>/dev/null | tr -d '[:space:]')" || SEEDED=""

case "$SEEDED" in
    ''|*[!0-9]*) echo "seed-fixtures: could not count seeded accounts (got '$SEEDED')"; summarise "$SEED_LOG"; exit 1 ;;
esac

if [ "$SEEDED" -lt "$USERS" ]; then
    echo "seed-fixtures: only $SEEDED accounts exist, expected $USERS"
    summarise "$SEED_LOG"
    exit 1
fi

HASHLESS="$($COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-assetflow}" \
    -d "${POSTGRES_DB:-assetflow}" -tAc \
    "SELECT count(*) FROM \"User\" WHERE email LIKE 'loadtest-${RUN_ID}-%' AND (\"passwordHash\" IS NULL OR \"passwordHash\" = '')" \
    2>/dev/null | tr -d '[:space:]')" || HASHLESS=""

case "$HASHLESS" in
    ''|*[!0-9]*) echo "seed-fixtures: could not verify stored hashes (got '$HASHLESS')"; exit 1 ;;
esac
[ "$HASHLESS" = "0" ] || { echo "seed-fixtures: $HASHLESS account(s) have no password and could not sign in"; exit 1; }

if [ -n "$EVIDENCE_DIR" ]; then
    mkdir -p "$EVIDENCE_DIR"
    printf '%s' "$SEEDED" > "$EVIDENCE_DIR/fixture-users"
fi

say "verified $SEEDED accounts with stored hashes"

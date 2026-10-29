#!/usr/bin/env bash
#
# Turns a fresh Ubuntu box into an AssetFlow host — the same way, every time.
#
#   sudo ./provision-host.sh --domain 3.107.83.86.sslip.io --email you@example.com \
#        --secrets-file s3://assetflow-backups-.../assetflow/drill/20261029T101500Z/infra.env
#
# This is the script the rebuild drill runs after the new instance is up, so it
# has to work on a machine with nothing on it but Ubuntu and an SSH key. It is
# idempotent: a second run changes nothing and takes seconds instead of minutes.
#
# The steps, in order:
#   1. bootstrap the OS         docker, compose, k6, certbot, awscli, swap
#   2. the repository           clone (or pull) into --deploy-path
#   3. infra/.env               from --secrets-file, mode 0600, never from git
#   4. harden the server        key-only SSH, a firewall, unattended upgrades
#   5. the TLS certificate      Let's Encrypt for --domain, or --self-signed
#   6. the stack                docker compose up -d --build
#   7. the schema               prisma migrate, and the demo seed on an empty database
#   8. readiness                wait for /api/health/ready to answer 200
#   9. the timers               the nightly backup and the weekly restore check
#
# Usage:
#   ./provision-host.sh --secrets-file <path|s3://...> [options]
#
#   --domain <host>        the public name for the certificate (default: none)
#   --email <address>      the Let's Encrypt contact (required with --domain)
#   --self-signed          a self-signed certificate (the laptop demo)
#   --deploy-path <dir>    where the repository lives (default /opt/assetflow)
#   --repo <url>           the git remote (default: this repository)
#   --branch <name>        the branch to deploy (default main)
#   --secrets-file <src>   the filled-in infra/.env (local path or s3:// URI)
#   --skip-harden          leave the SSH/firewall settings alone
#   --dry-run              print the plan, change nothing
#   --help
#
# Exit codes: 0 = provisioned, 1 = a step failed, 2 = usage error
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

DOMAIN=""
EMAIL=""
SELF_SIGNED=false
DEPLOY_PATH="${DEPLOY_PATH:-/opt/assetflow}"
REPO_URL="${REPO_URL:-https://github.com/BhaveshSab/assetflow.git}"
BRANCH="${BRANCH:-main}"
SECRETS_FILE=""
SKIP_HARDEN=false
FORCE_PULL=false

while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="$2"; shift ;;
        --email) EMAIL="$2"; shift ;;
        --self-signed) SELF_SIGNED=true ;;
        --deploy-path) DEPLOY_PATH="$2"; shift ;;
        --repo) REPO_URL="$2"; shift ;;
        --branch) BRANCH="$2"; shift ;;
        --secrets-file) SECRETS_FILE="$2"; shift ;;
        --skip-harden) SKIP_HARDEN=true ;;
        --force-pull) FORCE_PULL=true ;;
        --dry-run|--help|-h) : ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
    shift
done

if [ "$SELF_SIGNED" = false ] && [ -n "$DOMAIN" ] && [ -z "$EMAIL" ]; then
    die "--domain needs --email (Let's Encrypt asks for a contact address)"
fi
if [ "$SELF_SIGNED" = false ] && [ -z "$DOMAIN" ]; then
    die "give me --domain <host> --email <address>, or --self-signed"
fi
if [ -z "$SECRETS_FILE" ]; then
    die "--secrets-file is required: infra/.env must never come from git (see infra/.env.example)"
fi

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
STARTED_AT="$(date +%s)"
REPORT="${DEPLOY_PATH}/docs/results/provision-${STAMP}.md"
STEPS=()

# The report is written into the repository, which may not be cloned yet — the
# rows are collected in memory and written at the end.
record() {
    local name="$1" started="$2" ended="$3"
    local seconds=$((ended - started))
    STEPS+=("| ${name} | ${seconds}s |")
    say "PROVISION_STEP name=${name} seconds=${seconds}"
}

step_start() { date +%s; }

say "=== provisioning ${DEPLOY_PATH} ==="
say "domain:  $([ "$SELF_SIGNED" = true ] && echo "(self-signed)" || echo "$DOMAIN")"
say "branch:  ${BRANCH}"
say "secrets: $(basename "$SECRETS_FILE")"

if [ "$DRY_RUN" = true ]; then
    say ""
    say "[dry-run] 1. run ${REPO_ROOT}/infra/scripts/bootstrap-host.sh (docker, compose, k6, certbot, awscli, swap)"
    say "[dry-run] 2. git clone --branch ${BRANCH} ${REPO_URL} ${DEPLOY_PATH}   (or git -C ${DEPLOY_PATH} pull --ff-only)"
    say "[dry-run] 3. install $(basename "$SECRETS_FILE") as ${DEPLOY_PATH}/infra/.env (mode 0600)"
    [ "$SKIP_HARDEN" = true ] && say "[dry-run] 4. skipped (--skip-harden)" || say "[dry-run] 4. sudo harden-server.sh"
    if [ "$SELF_SIGNED" = true ]; then
        say "[dry-run] 5. sudo issue-cert.sh --self-signed"
    else
        say "[dry-run] 5. sudo issue-cert.sh --domain ${DOMAIN} --email ${EMAIL}"
    fi
    say "[dry-run] 6. docker compose -f infra/docker-compose.yml up -d --build"
    say "[dry-run] 7. docker compose ... run --rm migrate   (prisma migrate deploy; seed only if the database has no users)"
    say "[dry-run] 8. wait for https://${DOMAIN:-<host>}/api/health/ready"
    say "[dry-run] 9. install infra/systemd/*.{service,timer} and enable the two timers"
    say "[dry-run] nothing was changed"
    exit 0
fi

if [ "$(id -u)" -eq 0 ]; then
    die "run this as the ubuntu user (it calls sudo itself) — bootstrap-host.sh refuses to run as root"
fi

# ------------------------------------------------------- 1. the operating system
START="$(step_start)"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    say "+ 1. docker is already installed"
else
    say "+ 1. bootstrapping the operating system"
    bash "${REPO_ROOT}/infra/scripts/bootstrap-host.sh"
fi
record "bootstrap (docker, compose, k6, certbot, awscli, swap)" "$START" "$(date +%s)"

# ------------------------------------------------------------- 2. the repository
START="$(step_start)"
say "+ 2. the repository at ${DEPLOY_PATH}"
sudo mkdir -p "$DEPLOY_PATH"
sudo chown "$USER":"$USER" "$DEPLOY_PATH"
if [ -d "${DEPLOY_PATH}/.git" ]; then
    # `reset --hard` is the right move for a deploy checkout and the wrong move
    # for a developer's working copy, so it refuses to throw work away.
    if [ -n "$(git -C "$DEPLOY_PATH" status --porcelain)" ] && [ "$FORCE_PULL" = false ]; then
        die "${DEPLOY_PATH} has uncommitted changes — commit or stash them, or pass --force-pull"
    fi
    git -C "$DEPLOY_PATH" fetch --quiet origin "$BRANCH"
    git -C "$DEPLOY_PATH" checkout --quiet "$BRANCH"
    git -C "$DEPLOY_PATH" reset --hard --quiet "origin/${BRANCH}"
    say "  pulled ${BRANCH} → $(git -C "$DEPLOY_PATH" rev-parse --short HEAD)"
else
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DEPLOY_PATH"
    say "  cloned ${BRANCH} → $(git -C "$DEPLOY_PATH" rev-parse --short HEAD)"
fi
# The scripts live in the repository and must be executable.
chmod +x "${DEPLOY_PATH}"/infra/scripts/*.sh
record "the repository (clone/pull ${BRANCH})" "$START" "$(date +%s)"

# ------------------------------------------------------- 3. the configuration
START="$(step_start)"
say "+ 3. infra/.env from the private copy"
TMP_SECRETS="$(mktemp)"
trap 'rm -f "$TMP_SECRETS"' EXIT
case "$SECRETS_FILE" in
    s3://*)
        command -v aws >/dev/null 2>&1 || die "the AWS CLI is needed to read ${SECRETS_FILE}"
        aws s3 cp --only-show-errors "$SECRETS_FILE" "$TMP_SECRETS" >/dev/null
        ;;
    *)
        [ -f "$SECRETS_FILE" ] || die "the secrets file ${SECRETS_FILE} does not exist"
        cp "$SECRETS_FILE" "$TMP_SECRETS"
        ;;
esac
grep -q '^POSTGRES_PASSWORD=.\+' "$TMP_SECRETS" \
    || die "the secrets file has no POSTGRES_PASSWORD — that is not an infra/.env"

if [ -f "${DEPLOY_PATH}/infra/.env" ] && cmp -s "$TMP_SECRETS" "${DEPLOY_PATH}/infra/.env"; then
    say "  infra/.env is already current"
else
    # 0600: the file holds the database, the JWT secret and the bot token.
    install -m 600 "$TMP_SECRETS" "${DEPLOY_PATH}/infra/.env"
    say "  installed (mode 0600)"
fi
rm -f "$TMP_SECRETS"
# The Postgres credentials the seed check and the health check below need; the
# file is the same one the containers read.
set -a
# shellcheck disable=SC1091
. "${DEPLOY_PATH}/infra/.env"
set +a
record "the configuration (infra/.env, 0600)" "$START" "$(date +%s)"

# ------------------------------------------------------------ 4. hardening
START="$(step_start)"
if [ "$SKIP_HARDEN" = true ]; then
    say "+ 4. hardening skipped (--skip-harden)"
elif [ -f /etc/ssh/sshd_config.d/10-hardening.conf ]; then
    say "+ 4. the host is already hardened"
else
    say "+ 4. hardening the host"
    sudo bash "${DEPLOY_PATH}/infra/scripts/harden-server.sh"
fi
record "hardening (SSH, firewall, unattended upgrades)" "$START" "$(date +%s)"

# ------------------------------------------------------------ 5. the certificate
START="$(step_start)"
CERT_FILE="${DEPLOY_PATH}/infra/certs/live/assetflow/fullchain.pem"
if [ -f "$CERT_FILE" ] && [ "$SELF_SIGNED" = false ]; then
    # A cached certificate is reused: re-issuing on every provision would burn
    # the Let's Encrypt rate limit for the domain.
    say "+ 5. the certificate is already present (re-used)"
elif [ "$SELF_SIGNED" = true ]; then
    say "+ 5. a self-signed certificate"
    sudo bash "${DEPLOY_PATH}/infra/scripts/issue-cert.sh" --self-signed
else
    say "+ 5. a Let's Encrypt certificate for ${DOMAIN}"
    sudo bash "${DEPLOY_PATH}/infra/scripts/issue-cert.sh" --domain "$DOMAIN" --email "$EMAIL"
fi
record "the TLS certificate" "$START" "$(date +%s)"

# ---------------------------------------------------------------- 6. the stack
START="$(step_start)"
say "+ 6. the stack"
cd "$DEPLOY_PATH"
compose up -d --build
record "docker compose up -d --build" "$START" "$(date +%s)"

# --------------------------------------------------------------- 7. the schema
START="$(step_start)"
say "+ 7. the schema"
compose run --rm -T migrate >/dev/null
USERS="$(compose exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" postgres \
    psql -U "${POSTGRES_USER:-assetflow}" -d "${POSTGRES_DB:-assetflow}" \
    -tAc 'select count(*) from "User"' 2>/dev/null | tr -d '[:space:]' || echo "")"
if [ "${USERS:-0}" = "0" ]; then
    say "  the database is empty — seeding the demo data"
    compose run --rm -T migrate npm run seed >/dev/null
else
    say "  the database already has ${USERS} users — no seed"
fi
record "the schema and the seed" "$START" "$(date +%s)"

# ------------------------------------------------------------- 8. readiness
START="$(step_start)"
say "+ 8. waiting for the API to be ready"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"
HEALTH_URL_ARGS=(--resolve "${DOMAIN:-localhost}:80:127.0.0.1")
if [ "$SELF_SIGNED" = true ] || [ -z "$DOMAIN" ]; then
    HEALTH_PATH="http://localhost/api/health/ready"
    CURL_EXTRA=(-f)
else
    HEALTH_PATH="https://${DOMAIN}/api/health/ready"
    CURL_EXTRA=(-f)
    HEALTH_URL_ARGS=(--resolve "${DOMAIN}:443:127.0.0.1")
fi
READY=false
for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
    if curl -sS "${CURL_EXTRA[@]}" -m 5 "${HEALTH_URL_ARGS[@]}" "$HEALTH_PATH" >/dev/null 2>&1; then
        READY=true
        break
    fi
    sleep 1
done
[ "$READY" = true ] || die "the API did not become ready within ${HEALTH_TIMEOUT}s (docker compose logs api)"
say "  ready after $(( $(date +%s) - START ))s"
record "readiness (/api/health/ready)" "$START" "$(date +%s)"

# --------------------------------------------------------------- 9. the timers
START="$(step_start)"
say "+ 9. the systemd timers"
if [ -f /etc/systemd/system/assetflow-backup.timer ]; then
    say "  the timers are already installed"
else
    sudo cp "${DEPLOY_PATH}"/infra/systemd/assetflow-*.service /etc/systemd/system/
    sudo cp "${DEPLOY_PATH}"/infra/systemd/assetflow-*.timer /etc/systemd/system/
    # The units assume /opt/assetflow; another path is a documented deviation.
    if [ "$DEPLOY_PATH" != "/opt/assetflow" ]; then
        sudo sed -i "s|/opt/assetflow|${DEPLOY_PATH}|g" \
            /etc/systemd/system/assetflow-*.service
    fi
    sudo systemctl daemon-reload
    sudo systemctl enable --now assetflow-backup.timer assetflow-restore-verify.timer
    say "  enabled"
fi
record "the systemd timers" "$START" "$(date +%s)"

# ------------------------------------------------------------------ the report
TOTAL=$(( $(date +%s) - STARTED_AT ))
mkdir -p "${DEPLOY_PATH}/docs/results"
{
    echo "# Provisioning a fresh host — ${STAMP}"
    echo ""
    echo "Generated by \`infra/scripts/provision-host.sh\`. A fresh Ubuntu box"
    echo "became an AssetFlow host in **${TOTAL}s**."
    echo ""
    echo "| Step | Duration |"
    echo "|---|---|"
    for row in "${STEPS[@]}"; do echo "$row"; done
    echo "| **total** | **${TOTAL}s** |"
    echo ""
    echo "| Item | Value |"
    echo "|---|---|"
    echo "| Host | $(hostname) · $(nproc) vCPU · $(awk '/^MemTotal:/{printf "%.1f", $2/1024/1024}' /proc/meminfo) GiB |"
    echo "| Commit | $(git -C "$DEPLOY_PATH" rev-parse HEAD) |"
    echo "| Domain | ${DOMAIN:-none (self-signed)} |"
    echo "| Docker | $(docker --version) |"
    echo ""
    echo "## The command"
    echo ""
    echo '```bash'
    echo "sudo infra/scripts/provision-host.sh --deploy-path ${DEPLOY_PATH} \\"
    if [ "$SELF_SIGNED" = true ]; then
        echo "  --self-signed --secrets-file <the infra/.env copy>"
    else
        echo "  --domain ${DOMAIN} --email <address> --secrets-file <the infra/.env copy>"
    fi
    echo '```'
} >"$REPORT"

say ""
say "=== provisioned in ${TOTAL}s ==="
say "report: ${REPORT}"

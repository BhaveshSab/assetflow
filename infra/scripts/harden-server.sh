#!/usr/bin/env bash
#
# Hardens a fresh Ubuntu server.
#
# The rules it follows:
#   * SSH with a key only — no password login
#   * only the ports that are needed are open
#   * the security updates are installed automatically
#   * the logs cannot fill the disk
#
# Usage:
#   sudo ./harden-server.sh [--dry-run]
#
# Exit codes: 0 = ok, 1 = error
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

[ "$(id -u)" -eq 0 ] || die "this script needs root (run it with sudo)"

say "=== hardening the server ==="

# ---------------------------------------------------------------- SSH ------
say "→ SSH: key authentication only"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] write /etc/ssh/sshd_config.d/10-hardening.conf"
else
    cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'CONF'
# AssetFlow hardening — key authentication only.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
AllowUsers ubuntu
CONF
    systemctl reload ssh || systemctl reload sshd || warn "could not reload ssh"
    say "  done"
fi

# --------------------------------------------------------------- firewall ---
say "→ UFW: only 22, 80 and 443 are open"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] ufw default deny incoming && ufw allow 22/80/443 && ufw enable"
else
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow 22/tcp comment 'SSH'
    ufw allow 80/tcp comment 'HTTP (redirect + ACME)'
    ufw allow 443/tcp comment 'HTTPS'
    ufw --force enable
    say "  done"
fi

# --------------------------------------------------------------- updates ---
say "→ unattended-upgrades: security patches are installed automatically"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] apt install unattended-upgrades && dpkg-reconfigure"
else
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq unattended-upgrades >/dev/null
    dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null
    say "  done"
fi

# ----------------------------------------------------------------- logs ----
say "→ journald: the logs may not fill the disk"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] write /etc/systemd/journald.conf.d/10-size-limit.conf"
else
    mkdir -p /etc/systemd/journald.conf.d
    cat > /etc/systemd/journald.conf.d/10-size-limit.conf <<'CONF'
[Journal]
SystemMaxUse=500M
MaxRetentionSec=2week
CONF
    systemctl restart systemd-journald || warn "could not restart journald"
    say "  done"
fi

# ----------------------------------------------------------------- swap ----
say "→ swap: off (a database must not swap)"
if [ "$DRY_RUN" = true ]; then
    say "[dry-run] swapoff -a && sed -i '/ swap / s/^/#/' /etc/fstab"
else
    swapoff -a 2>/dev/null || true
    sed -i '/ swap / s/^/#/' /etc/fstab
    say "  done"
fi

say "=== the server is hardened ==="
say "next steps: install Docker, copy the .env, run the deployment script"

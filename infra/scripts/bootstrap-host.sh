#!/usr/bin/env bash
#
# One-time bootstrap of an Ubuntu EC2 host for the AssetFlow stack.
#
# Run it as the `ubuntu` user (the script calls sudo for the root steps):
#
#   ssh -i assetflow-key.pem ubuntu@<host> 'bash -s' < infra/scripts/bootstrap-host.sh
#
# It is idempotent: a second run changes nothing.
#
# Installs: Docker Engine + Compose plugin, certbot, AWS CLI, PostgreSQL
# client (pg_dump/psql for the backup scripts), k6, and 2 GB of swap. The
# t3.micro has 1 GB of RAM; the image builds and Prometheus need the swap.
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
    echo "Run as the ubuntu user, not as root (the script uses sudo itself)." >&2
    exit 1
fi

if sudo -n true 2>/dev/null; then
    SUDO=(sudo -n)
else
    SUDO=(sudo)
fi

export DEBIAN_FRONTEND=noninteractive

echo "== packages =="
"${SUDO[@]}" apt-get update -qq
"${SUDO[@]}" apt-get install -y -qq \
    ca-certificates curl gnupg git openssl jq \
    certbot awscli postgresql-client

if ! command -v docker >/dev/null 2>&1; then
    echo "== Docker (official repository) =="
    "${SUDO[@]}" install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | "${SUDO[@]}" gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    "${SUDO[@]}" chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        | "${SUDO[@]}" tee /etc/apt/sources.list.d/docker.list >/dev/null
    "${SUDO[@]}" apt-get update -qq
    "${SUDO[@]}" apt-get install -y -qq \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

"${SUDO[@]}" systemctl enable --now docker
"${SUDO[@]}" usermod -aG docker "$USER"

echo "== swap =="
if ! swapon --show | grep -q '/swapfile'; then
    if [ ! -f /swapfile ]; then
        "${SUDO[@]}" fallocate -l 2G /swapfile \
            || "${SUDO[@]}" dd if=/dev/zero of=/swapfile bs=1M count=2048
        "${SUDO[@]}" chmod 600 /swapfile
        "${SUDO[@]}" mkswap /swapfile
    fi
    "${SUDO[@]}" swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab \
        || echo '/swapfile none swap sw 0 0' | "${SUDO[@]}" tee -a /etc/fstab >/dev/null
fi

echo "== k6 =="
if ! command -v k6 >/dev/null 2>&1; then
    K6_VERSION="v0.54.0"
    case "$(dpkg --print-architecture)" in
        amd64) K6_ARCH=amd64 ;;
        arm64) K6_ARCH=arm64 ;;
        *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;;
    esac
    curl -fsSL "https://github.com/grafana/k6/releases/download/${K6_VERSION}/k6-${K6_VERSION}-linux-${K6_ARCH}.tar.gz" -o /tmp/k6.tgz
    tar -xzf /tmp/k6.tgz -C /tmp
    "${SUDO[@]}" install -m 0755 "/tmp/k6-${K6_VERSION}-linux-${K6_ARCH}/k6" /usr/local/bin/k6
fi

echo "== versions =="
docker --version
certbot --version 2>&1 | head -1
aws --version 2>&1 | head -1
psql --version
k6 version
free -h | head -2

echo
echo "Bootstrap complete. Docker group membership applies to NEW SSH sessions."
echo "The current session must reconnect (or run: newgrp docker)."

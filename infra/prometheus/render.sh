#!/bin/sh
# Render the Prometheus configuration from the mounted template.
#
# Only one value is substituted: PUBLIC_BASE_URL, the address the blackbox
# exporter probes for the TLS-expiry alert. The upstream prom/prometheus image
# has no envsubst, but it does have sed — the same trick alertmanager/render.sh
# uses.
#
# The rendered file goes to /tmp because /etc/prometheus is mounted read-only.
set -eu

: "${PUBLIC_BASE_URL:=https://nginx}"

sed -e "s|\${PUBLIC_BASE_URL}|${PUBLIC_BASE_URL}|g" \
    /etc/prometheus/prometheus.template.yml \
    > /tmp/prometheus.yml

exec /bin/prometheus --config.file=/tmp/prometheus.yml "$@"

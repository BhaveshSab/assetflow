#!/bin/sh
# Render the Alertmanager configuration from the mounted template.
#
# The upstream prom/alertmanager image has no envsubst, but it does have sed.
# The credentials arrive through `env_file: .env`; they are never baked into
# the image or committed.
set -eu

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is not set}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID is not set}"

sed \
    -e "s|\${TELEGRAM_BOT_TOKEN}|${TELEGRAM_BOT_TOKEN}|g" \
    -e "s|\${TELEGRAM_CHAT_ID}|${TELEGRAM_CHAT_ID}|g" \
    /etc/alertmanager/alertmanager.template.yml \
    > /etc/alertmanager/alertmanager.yml

exec /bin/alertmanager \
    --config.file=/etc/alertmanager/alertmanager.yml \
    --storage.path=/alertmanager

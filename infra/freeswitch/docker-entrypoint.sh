#!/usr/bin/env bash
set -euo pipefail

: "${ESL_PASSWORD:?ESL_PASSWORD is required}"
: "${SIP_DEFAULT_PASSWORD:?SIP_DEFAULT_PASSWORD is required}"

FREESWITCH_DOMAIN="${FREESWITCH_DOMAIN:-sip.local}"
FREESWITCH_EXTERNAL_IP="${FREESWITCH_EXTERNAL_IP:-auto-nat}"

escape_sed() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

rendered_esl_password="$(escape_sed "$ESL_PASSWORD")"
sed "s|__ESL_PASSWORD__|${rendered_esl_password}|g" \
  /opt/sip-server/event_socket.conf.xml.template \
  > /etc/freeswitch/autoload_configs/event_socket.conf.xml

vars_file=/etc/freeswitch/vars.xml
sed -i \
  -e "s|data=\"domain=.*\"|data=\"domain=$(escape_sed "$FREESWITCH_DOMAIN")\"|" \
  -e "s|data=\"default_password=.*\"|data=\"default_password=$(escape_sed "$SIP_DEFAULT_PASSWORD")\"|" \
  -e "s|data=\"external_rtp_ip=.*\"|data=\"external_rtp_ip=$(escape_sed "$FREESWITCH_EXTERNAL_IP")\"|" \
  -e "s|data=\"external_sip_ip=.*\"|data=\"external_sip_ip=$(escape_sed "$FREESWITCH_EXTERNAL_IP")\"|" \
  "$vars_file"

# The vanilla internal profile enables WSS even when SIP TLS is disabled. WSS
# requires a separately managed certificate, so keep it off for this SIP-only
# deployment until certificate provisioning is added.
sed -i '/<param name="wss-binding" value=":7443"\/>/d' \
  /etc/freeswitch/sip_profiles/internal.xml

install -d -o freeswitch -g freeswitch \
  /var/lib/freeswitch/recordings \
  /var/lib/freeswitch/storage \
  /var/lib/freeswitch/db \
  /var/log/freeswitch \
  /run/freeswitch

exec "$@"

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
# Put preset numbers before the vanilla 88* eavesdrop route.
default_dialplan=/etc/freeswitch/dialplan/default.xml
if ! grep -q 'data="default/00_preset_broadcast.xml"' "$default_dialplan"; then
  sed -i '/<context name="default">/a\    <X-PRE-PROCESS cmd="include" data="default/00_preset_broadcast.xml"/>' "$default_dialplan"
fi
sed -i \
  -e "s|data=\"domain=.*\"|data=\"domain=$(escape_sed "$FREESWITCH_DOMAIN")\"|" \
  -e "s|data=\"default_password=.*\"|data=\"default_password=$(escape_sed "$SIP_DEFAULT_PASSWORD")\"|" \
  -e "s|data=\"external_rtp_ip=.*\"|data=\"external_rtp_ip=$(escape_sed "$FREESWITCH_EXTERNAL_IP")\"|" \
  -e "s|data=\"external_sip_ip=.*\"|data=\"external_sip_ip=$(escape_sed "$FREESWITCH_EXTERNAL_IP")\"|" \
  -e 's|data="global_codec_prefs=.*"|data="global_codec_prefs=OPUS,G722,PCMU,PCMA"|' \
  -e 's|data="outbound_codec_prefs=.*"|data="outbound_codec_prefs=OPUS,G722,PCMU,PCMA"|' \
  "$vars_file"

# The sample profile enables WebSocket transports, but this deployment only
# exposes SIP over UDP/TCP. Removing those bindings also avoids requiring a
# WSS certificate for a profile that is not published.
sed -i \
  -e '/name="ws-binding"/d' \
  -e '/name="wss-binding"/d' \
  /etc/freeswitch/sip_profiles/internal.xml

# mod_pgsql is part of the vanilla pre-load sample but is intentionally not
# included in this minimal source build.
sed -i '/mod_pgsql/d' /etc/freeswitch/autoload_configs/pre_load_modules.conf.xml

install -d -o freeswitch -g freeswitch \
  /var/lib/freeswitch/recordings \
  /var/lib/freeswitch/storage \
  /var/log/freeswitch \
  /run/freeswitch

exec "$@"

#!/usr/bin/env bash
set -euo pipefail

: "${ESL_PASSWORD:?ESL_PASSWORD is required}"
: "${SIP_DEFAULT_PASSWORD:?SIP_DEFAULT_PASSWORD is required}"

FREESWITCH_DOMAIN="${FREESWITCH_DOMAIN:-sip.local}"
FREESWITCH_EXTERNAL_IP="${FREESWITCH_EXTERNAL_IP:-auto-nat}"
# 编解码优先级（逗号分隔，越靠前越优先）。G722 即 G.722 宽带语音：
# 实际采样 16 kHz / 64 kbps，SDP 中按 RFC 3551 写作 G722/8000。
FREESWITCH_CODEC_PREFS="${FREESWITCH_CODEC_PREFS:-OPUS,G722,PCMU,PCMA}"

escape_sed() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

rendered_esl_password="$(escape_sed "$ESL_PASSWORD")"
sed "s|__ESL_PASSWORD__|${rendered_esl_password}|g" \
  /opt/sip-server/event_socket.conf.xml.template \
  > /etc/freeswitch/autoload_configs/event_socket.conf.xml

vars_file=/etc/freeswitch/vars.xml
# Put preset / local-extension numbers before the vanilla 88* eavesdrop and
# 80xx callgroup routes, otherwise dialing them hits the sample behaviour.
default_dialplan=/etc/freeswitch/dialplan/default.xml
for route in 00_preset_broadcast.xml 01_local_extensions.xml; do
  if [[ -f "/etc/freeswitch/dialplan/default/${route}" ]] \
    && ! grep -q "data=\"default/${route}\"" "$default_dialplan"; then
    sed -i "/<context name=\"default\">/a\\    <X-PRE-PROCESS cmd=\"include\" data=\"default/${route}\"/>" "$default_dialplan"
  fi
done

# The sales/billing/support groups in the vanilla directory are pointer-only and
# point at demo extensions 1000~1014, which the API replaces with the 8XXX range.
# Dangling pointers would make FreeSWITCH expose password-less phantom users.
# (awk rather than python3: the runtime stage does not install Python.)
if grep -q '<group name="sales">' /etc/freeswitch/directory/default.xml; then
  awk '
    /<group name="(sales|billing|support)">/ { skip = 1 }
    skip && /<\/group>/ { skip = 0; next }
    !skip { print }
  ' /etc/freeswitch/directory/default.xml > /etc/freeswitch/directory/default.xml.tmp \
    && mv /etc/freeswitch/directory/default.xml.tmp /etc/freeswitch/directory/default.xml
fi
sed -i \
  -e "s|data=\"domain=.*\"|data=\"domain=$(escape_sed "$FREESWITCH_DOMAIN")\"|" \
  -e "s|data=\"default_password=.*\"|data=\"default_password=$(escape_sed "$SIP_DEFAULT_PASSWORD")\"|" \
  -e "s|data=\"external_rtp_ip=.*\"|data=\"external_rtp_ip=$(escape_sed "$FREESWITCH_EXTERNAL_IP")\"|" \
  -e "s|data=\"external_sip_ip=.*\"|data=\"external_sip_ip=$(escape_sed "$FREESWITCH_EXTERNAL_IP")\"|" \
  -e "s|data=\"global_codec_prefs=.*\"|data=\"global_codec_prefs=$(escape_sed "$FREESWITCH_CODEC_PREFS")\"|" \
  -e "s|data=\"outbound_codec_prefs=.*\"|data=\"outbound_codec_prefs=$(escape_sed "$FREESWITCH_CODEC_PREFS")\"|" \
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

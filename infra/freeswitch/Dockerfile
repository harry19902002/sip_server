# syntax=docker/dockerfile:1.7
ARG DEBIAN_VERSION=bookworm
FROM debian:${DEBIAN_VERSION}

ARG FREESWITCH_VERSION=1.11
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg2 locales \
    && localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

# SignalWire's official Debian repository requires a Personal Access Token.
# BuildKit mounts it for this layer only; it is not copied into the image.
RUN --mount=type=secret,id=signalwire_token \
    set -eu; \
    token="$(cat /run/secrets/signalwire_token)"; \
    curl --fail --silent --show-error \
      --user "signalwire:${token}" \
      -o /usr/share/keyrings/signalwire-freeswitch-repo.gpg \
      https://freeswitch.signalwire.com/repo/deb/debian-release/signalwire-freeswitch-repo.gpg; \
    printf 'machine freeswitch.signalwire.com login signalwire password %s\n' "$token" > /etc/apt/auth.conf.d/freeswitch.conf; \
    printf 'deb [signed-by=/usr/share/keyrings/signalwire-freeswitch-repo.gpg] https://freeswitch.signalwire.com/repo/deb/debian-release/ bookworm main\n' > /etc/apt/sources.list.d/freeswitch.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      freeswitch-meta-vanilla="${FREESWITCH_VERSION}*" \
      freeswitch-mod-event-socket \
      freeswitch-mod-commands \
      freeswitch-mod-conference \
      freeswitch-mod-dptools \
      freeswitch-mod-sofia; \
    rm -f /etc/apt/auth.conf.d/freeswitch.conf; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

COPY docker-entrypoint.sh /usr/local/bin/sip-server-freeswitch-entrypoint

EXPOSE 5060/tcp 5060/udp 8021/tcp 16384-16484/udp

ENTRYPOINT ["/bin/bash", "/usr/local/bin/sip-server-freeswitch-entrypoint"]
CMD ["freeswitch", "-u", "freeswitch", "-g", "freeswitch", "-nonat", "-nf"]

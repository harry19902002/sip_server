# syntax=docker/dockerfile:1.7
ARG DEBIAN_VERSION=bookworm

FROM debian:${DEBIAN_VERSION} AS builder

ARG FREESWITCH_VERSION=1.11.2
ARG SOFIA_SIP_VERSION=1.13.18
ARG SPANDSP_VERSION=3.1.1
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      autoconf automake build-essential ca-certificates cmake git libtool-bin make nasm pkg-config yasm \
      libcurl4-openssl-dev libedit-dev libflac-dev libjpeg62-turbo-dev libldns-dev \
      libmp3lame-dev libmpg123-dev libncurses-dev libogg-dev libopus-dev libpcre2-dev \
      libshout3-dev libsndfile1-dev libspeex-dev libspeexdsp-dev libsqlite3-dev \
      libssl-dev libtiff-dev libuuid1 libvorbis-dev libxml2-dev uuid-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# FreeSWITCH 1.11 requires a newer Sofia-SIP than Debian bookworm provides.
# Build both projects from immutable GitHub release tags so the image is
# reproducible and no SignalWire package-repository token is required.
WORKDIR /usr/src
RUN set -eu; \
    for attempt in 1 2 3; do \
      git -c http.version=HTTP/1.1 clone --depth 1 --filter=blob:none --branch "v${SOFIA_SIP_VERSION}" \
        https://github.com/freeswitch/sofia-sip.git sofia-sip && break; \
      rm -rf sofia-sip; sleep $((attempt * 5)); \
    done; \
    test -d sofia-sip/.git \
    && cd sofia-sip \
    && ./bootstrap.sh \
    && ./configure --prefix=/usr/local --disable-static \
    && make -j"$(nproc)" \
    && make install \
    && ldconfig

RUN set -eu; \
    for attempt in 1 2 3; do \
      git -c http.version=HTTP/1.1 clone --depth 1 --filter=blob:none --branch "v${SPANDSP_VERSION}" \
        https://github.com/freeswitch/spandsp.git spandsp && break; \
      rm -rf spandsp; sleep $((attempt * 5)); \
    done; \
    test -d spandsp/.git \
    && cd spandsp \
    && ./bootstrap.sh \
    && ./configure --prefix=/usr/local --disable-static --disable-doc \
    && make -j"$(nproc)" \
    && make install \
    && ldconfig

COPY modules.conf /tmp/freeswitch-modules.conf

RUN set -eu; \
    for attempt in 1 2 3; do \
      git -c http.version=HTTP/1.1 clone --depth 1 --filter=blob:none --branch "v${FREESWITCH_VERSION}" \
        https://github.com/signalwire/freeswitch.git freeswitch && break; \
      rm -rf freeswitch; sleep $((attempt * 5)); \
    done; \
    test -d freeswitch/.git \
    && cd freeswitch \
    && ./bootstrap.sh -j \
    && cp /tmp/freeswitch-modules.conf modules.conf \
    && PKG_CONFIG_PATH=/usr/local/lib/pkgconfig ./configure \
      --prefix=/usr \
      --sysconfdir=/etc \
      --localstatedir=/var \
      --with-rundir=/run/freeswitch \
      --with-logfiledir=/var/log/freeswitch \
      --with-dbdir=/var/lib/freeswitch/db \
      --with-storagedir=/var/lib/freeswitch/storage \
      --with-recordingsdir=/var/lib/freeswitch/recordings \
    && make -j"$(nproc)" \
    && make install DESTDIR=/opt/freeswitch-root

FROM debian:${DEBIAN_VERSION}

ARG FREESWITCH_VERSION=1.11.2
LABEL org.opencontainers.image.source="https://github.com/signalwire/freeswitch" \
      org.opencontainers.image.version="${FREESWITCH_VERSION}"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates locales \
      libcurl4 libedit2 libflac12 libjpeg62-turbo libldns3 libmp3lame0 libmpg123-0 \
      libncurses6 libogg0 libopus0 libpcre2-8-0 libshout3 libsndfile1 libspeex1 \
      libspeexdsp1 libsqlite3-0 libssl3 libtiff6 libuuid1 libvorbis0a libvorbisenc2 libxml2 zlib1g \
    && localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8 \
    && groupadd --system freeswitch \
    && useradd --system --gid freeswitch --home-dir /var/lib/freeswitch --shell /usr/sbin/nologin freeswitch \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/lib/ /usr/local/lib/
COPY --from=builder /opt/freeswitch-root/ /
COPY config/modules.conf.xml /etc/freeswitch/autoload_configs/modules.conf.xml
COPY config/acl.conf.xml /etc/freeswitch/autoload_configs/acl.conf.xml
COPY docker-entrypoint.sh /usr/local/bin/sip-server-freeswitch-entrypoint

RUN sed -i 's/\r$//' /usr/local/bin/sip-server-freeswitch-entrypoint \
    && ldconfig \
    && chmod 0755 /usr/local/bin/sip-server-freeswitch-entrypoint \
    && install -d -o freeswitch -g freeswitch \
      /var/lib/freeswitch/db /var/lib/freeswitch/recordings /var/lib/freeswitch/storage \
      /var/log/freeswitch /run/freeswitch

EXPOSE 5060/tcp 5060/udp 8021/tcp 16384-16484/udp

ENTRYPOINT ["/bin/bash", "/usr/local/bin/sip-server-freeswitch-entrypoint"]
CMD ["freeswitch", "-u", "freeswitch", "-g", "freeswitch", "-nonat", "-nf"]

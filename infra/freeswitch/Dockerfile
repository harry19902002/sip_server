# syntax=docker/dockerfile:1.7
ARG DEBIAN_VERSION=bookworm

FROM debian:${DEBIAN_VERSION} AS builder

ARG FREESWITCH_REF=v1.11.1
ARG BUILD_JOBS=2
ARG SPANDSP_REF=v3.1.0
ARG SOFIA_SIP_REF=v1.13.17
ENV DEBIAN_FRONTEND=noninteractive \
    PKG_CONFIG_PATH=/opt/freeswitch/lib/pkgconfig

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      autoconf automake build-essential ca-certificates cmake git libcurl4-openssl-dev \
      libedit-dev libjpeg-dev libldns-dev liblua5.2-dev libncurses-dev libopus-dev \
      libpcre2-dev libsndfile1-dev libspeex-dev libspeexdsp-dev libsqlite3-dev \
      libssl-dev libtiff-dev libtool libtool-bin libuuid1 libxml2-dev pkg-config \
      python3 uuid-dev yasm zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src

RUN git clone --branch "${SPANDSP_REF}" --depth 1 https://github.com/freeswitch/spandsp.git \
    && cd spandsp \
    && ./bootstrap.sh \
    && ./configure --prefix=/opt/freeswitch --disable-static \
    && make -j"${BUILD_JOBS}" \
    && make install

RUN git clone --branch "${SOFIA_SIP_REF}" --depth 1 https://github.com/freeswitch/sofia-sip.git \
    && cd sofia-sip \
    && ./autogen.sh \
    && ./configure --prefix=/opt/freeswitch --disable-static \
    && make -j"${BUILD_JOBS}" \
    && make install

RUN git clone --branch "${FREESWITCH_REF}" --depth 1 https://github.com/signalwire/freeswitch.git

WORKDIR /usr/src/freeswitch
COPY modules.conf ./modules.conf

RUN ./bootstrap.sh -j \
    && ./configure \
      --prefix=/opt/freeswitch \
      --disable-dependency-tracking \
      --disable-static \
      --enable-shared \
    && make -j"${BUILD_JOBS}" \
    && make install

RUN mkdir -p /opt/runtime-conf \
    && cp -a /usr/src/freeswitch/conf/vanilla/. /opt/runtime-conf/

FROM debian:${DEBIAN_VERSION} AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    PATH=/opt/freeswitch/bin:${PATH} \
    LD_LIBRARY_PATH=/opt/freeswitch/lib

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates locales libcurl4 libedit2 libjpeg62-turbo libldns3 liblua5.2-0 \
      libmpg123-0 libncurses6 libopus0 libpcre2-8-0 libsndfile1 libspeex1 \
      libspeexdsp1 libsqlite3-0 libssl3 libtiff6 libuuid1 libxml2 zlib1g \
    && localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8 \
    && groupadd --system --gid 499 freeswitch \
    && useradd --system --uid 499 --gid freeswitch --home-dir /var/lib/freeswitch freeswitch \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/freeswitch /opt/freeswitch
COPY --from=builder /opt/runtime-conf /etc/freeswitch
COPY docker-entrypoint.sh /usr/local/bin/sip-server-freeswitch-entrypoint

RUN install -d -o freeswitch -g freeswitch \
      /var/lib/freeswitch/recordings \
      /var/lib/freeswitch/storage \
      /var/lib/freeswitch/db \
      /var/log/freeswitch \
      /run/freeswitch \
    && chown -R freeswitch:freeswitch /etc/freeswitch

EXPOSE 5060/tcp 5060/udp 8021/tcp 16384-16484/udp

ENTRYPOINT ["/bin/bash", "/usr/local/bin/sip-server-freeswitch-entrypoint"]
CMD ["freeswitch", "-conf", "/etc/freeswitch", "-log", "/var/log/freeswitch", "-db", "/var/lib/freeswitch/db", "-u", "freeswitch", "-g", "freeswitch", "-nonat", "-nf"]

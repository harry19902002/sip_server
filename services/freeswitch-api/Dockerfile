FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache su-exec

COPY package.json ./
COPY lib ./lib
COPY server.mjs healthcheck.mjs ./
COPY docker-entrypoint.sh /usr/local/bin/sip-api-entrypoint

RUN sed -i 's/\r$//' /usr/local/bin/sip-api-entrypoint \
    && chmod 0755 /usr/local/bin/sip-api-entrypoint \
    && mkdir -p /data /media

EXPOSE 3001

ENTRYPOINT ["/usr/local/bin/sip-api-entrypoint"]
CMD ["node", "server.mjs"]

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY lib ./lib
COPY server.mjs healthcheck.mjs ./

RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3001

CMD ["node", "server.mjs"]

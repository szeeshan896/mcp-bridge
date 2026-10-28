# syntax=docker/dockerfile:1
# Builds the relay. The CLI package is built first because the relay depends on it
# (relay/package.json: "mcpbridge": "file:..") for the shared wire protocol.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build

COPY relay/package.json relay/package-lock.json relay/tsconfig.json ./relay/
COPY relay/src ./relay/src
# Any npm operation on the relay -- install *and* prune -- runs the linked parent's
# `prepare` (npm does that for file: dependencies, --ignore-scripts or not), and that
# runs tsc. So the relay is pruned first, while the parent still has typescript, and the
# parent is pruned last, after which nothing touches the relay's tree again.
RUN cd relay && npm ci && npm run build
RUN cd relay && npm prune --omit=dev
RUN npm prune --omit=dev

FROM node:22-alpine
# RELAY_RUN_AS is the image's `node` user. The container starts as root only so the relay
# can take ownership of a volume mounted over /data, which hosts such as Railway mount
# owned by root; it switches to this user before it opens the database or a port.
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATABASE_PATH=/data/relay.sqlite RELAY_RUN_AS=1000:1000
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/relay/package.json /app/relay/package-lock.json ./relay/
COPY --from=build /app/relay/dist ./relay/dist
COPY --from=build /app/relay/node_modules ./relay/node_modules
# the database lives on a mounted volume; without one, the image's own /data is used
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "relay/dist/index.js"]

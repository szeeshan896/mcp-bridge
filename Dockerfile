# syntax=docker/dockerfile:1
# Builds the relay. The CLI package is built first because the relay depends on it
# (relay/package.json: "mcpbridge": "file:..") for the shared wire protocol.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

COPY relay/package.json relay/package-lock.json relay/tsconfig.json ./relay/
COPY relay/src ./relay/src
RUN cd relay && npm ci --ignore-scripts && npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATABASE_PATH=/data/relay.sqlite
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/relay/package.json /app/relay/package-lock.json ./relay/
COPY --from=build /app/relay/dist ./relay/dist
COPY --from=build /app/relay/node_modules ./relay/node_modules
# the database lives on a mounted volume; the unprivileged user must be able to write it
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "relay/dist/index.js"]

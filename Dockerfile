FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/core packages/core
COPY scripts scripts
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    LIFEOS_HOST=0.0.0.0 \
    LIFEOS_PORT=3001 \
    LIFEOS_DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/apps/api/package.json apps/api/package.json
COPY --from=build --chown=node:node /app/apps/web/package.json apps/web/package.json
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist
COPY --from=build --chown=node:node /app/packages/core/package.json packages/core/package.json
COPY --from=build --chown=node:node /app/scripts scripts
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/packages/core/dist packages/core/dist

USER node
VOLUME ["/data"]
EXPOSE 3001
CMD ["node", "apps/api/dist/src/main.js"]

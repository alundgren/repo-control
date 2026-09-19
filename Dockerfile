FROM ghcr.io/voidzero-dev/vite-plus:0.3.0@sha256:bca24ac970b21298430ad281f306dbe0a17be3fd1d6c9ec5f2cc73da65740b88 AS build

WORKDIR /app

COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN vp install --frozen-lockfile

COPY --chown=vp:vp tsconfig.json tsconfig.server.json vite.config.ts ./
COPY --chown=vp:vp src ./src
RUN vp run build && vp pm prune --prod

# Keep the global CLI and its managed runtime available without development tools.
RUN cp "$(command -v vp)" /tmp/vp

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime

ENV VP_HOME=/opt/vite-plus \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIRECTORY=/var/lib/repo-control

WORKDIR /app

RUN mkdir -p /var/lib/repo-control && chown node:node /var/lib/repo-control

COPY --from=build /tmp/vp /usr/local/bin/vp
COPY --from=build --chown=node:node /home/vp/.vite-plus/js_runtime /opt/vite-plus/js_runtime
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 3000

CMD ["vp", "node", "dist/server/main.js"]

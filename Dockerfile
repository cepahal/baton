# One image for every role in docker-compose.test.yml: `baton serve`, and the
# simulated machines that run `baton replay` + `baton start --server`.
# Single stage: it's a test image, and pnpm's symlinked node_modules don't
# survive being copied between stages piecemeal.
FROM node:20-bookworm-slim
WORKDIR /app
ENV CI=true
# git: daemons use it to tell repos apart (`baton share`, canvas grouping).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates   && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/daemon/package.json packages/daemon/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm build
COPY docker/machine.sh /usr/local/bin/baton-machine
COPY docker/server.sh /usr/local/bin/baton-server
RUN chmod +x /usr/local/bin/baton-machine /usr/local/bin/baton-server
# Team server state as Baton 0.0.0 wrote it: the server starts on these, to test upgrades.
COPY scripts/multi/legacy-state /seed
ENTRYPOINT ["node", "packages/daemon/dist/index.js"]
CMD ["--help"]

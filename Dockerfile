# One image for every role in docker-compose.test.yml: `baton serve`, and the
# simulated machines that run `baton replay` + `baton start --server`.
# Single stage: it's a test image, and pnpm's symlinked node_modules don't
# survive being copied between stages piecemeal.
FROM node:20-bookworm-slim
WORKDIR /app
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/daemon/package.json packages/daemon/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm build
COPY docker/machine.sh /usr/local/bin/baton-machine
RUN chmod +x /usr/local/bin/baton-machine
ENTRYPOINT ["node", "packages/daemon/dist/index.js"]
CMD ["--help"]

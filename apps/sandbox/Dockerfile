# The sandbox runner: the one service that may start containers, and it starts only one
# kind. Built from the repository root: docker build -f apps/sandbox/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/sandbox ./apps/sandbox
RUN pnpm install --frozen-lockfile --filter @muster/sandbox... \
 && pnpm --filter @muster/sandbox build

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=7420 SANDBOX_SPACES=/spaces SANDBOX_IMAGE_DIR=/app/image
# Only Docker's command-line program: the daemon is the machine's own, reached by its socket.
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=build /repo/apps/sandbox/dist ./dist
COPY --from=build /repo/apps/sandbox/package.json ./package.json
COPY apps/sandbox/image ./image
RUN mkdir -p /spaces
ARG MUSTER_COMMIT=unknown
LABEL org.opencontainers.image.revision=$MUSTER_COMMIT
EXPOSE 7420
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]

# One image is the whole cloud deployment: the server, which also serves the built web app.
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY vendor ./vendor
COPY apps/server ./apps/server
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter "@muster/server..." --filter "@muster/web..." build
# Only what the server needs to run, with its production dependencies.
RUN pnpm --filter @muster/server deploy --prod --legacy /out/server \
 && cp -r apps/web/dist /out/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=7410 MUSTER_WEB_DIR=/app/web MUSTER_FILES_DIR=/data/files
# People's files live here; mount a volume on it.
RUN mkdir -p /data/files && chown -R node:node /data
WORKDIR /app/server
COPY --from=build /out/server ./
COPY --from=build /out/web /app/web
# The commit this was built from, so a deployment can tell which one is running.
ARG MUSTER_COMMIT=unknown
LABEL org.opencontainers.image.revision=$MUSTER_COMMIT
USER node
EXPOSE 7410
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/auth/providers').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]

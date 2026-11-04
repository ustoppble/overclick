# Self-hosted image. No analytics, no external fonts, no phone-home.
FROM node:22-bookworm-slim

# HOME and COREPACK_HOME: the app runs as an unprivileged user on a read-only
# root filesystem, so nothing may default to a cache under a home directory.
# corepack's copy of pnpm is prepared below, as root, into COREPACK_HOME, which
# the app user can read but not change; HOME is the tmpfs the compose file mounts.
ENV NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    PNPM_HOME=/pnpm \
    COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    HOME=/tmp \
    PATH=/pnpm:$PATH

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate \
    && chmod -R a+rX "$COREPACK_HOME"

COPY package.json pnpm-lock.yaml .npmrc ./
COPY pnpm-workspace.docker.yaml pnpm-workspace.yaml
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/mcp-core/package.json packages/mcp-core/package.json

# Only this image's packages. Sibling workspace folders stay out of the context.
# Lockfile also lists sibling workspace packages this image does not ship.
RUN pnpm install --no-frozen-lockfile --filter @agent-board/web...

COPY apps/web apps/web
COPY packages/db packages/db
COPY packages/mcp-core packages/mcp-core
COPY install.sh install.sh
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
# mcp-core resolves to dist/ (see its package exports); build it before the app.
RUN pnpm --filter @agent-board/mcp-core build
RUN pnpm --filter @agent-board/web build

# The runtime user has no shell and no home, and owns nothing it does not have
# to write: the code above stays root-owned and read-only to it, so a hole in the
# app cannot rewrite the app. The two directories it does write are created
# here, owned by it: /update-trigger (the volume the compose file mounts, which
# Docker seeds from this ownership on first creation) and Next's runtime cache.
RUN groupadd --system --gid 10001 overclick \
    && useradd --system --uid 10001 --gid overclick --no-create-home \
       --home-dir /nonexistent --shell /usr/sbin/nologin overclick \
    && install -d -o overclick -g overclick -m 0755 /update-trigger \
    && install -d -o overclick -g overclick -m 0755 /app/apps/web/.next/cache

USER overclick:overclick

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

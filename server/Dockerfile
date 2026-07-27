# Multi-stage Dockerfile for ScopeCash AI server
# - Build deps in a builder stage so final image is slim
# - Runs as non-root, no shell, drops capabilities by default

# ── Builder ──────────────────────────────────────────
FROM node:26-bookworm-slim AS builder
WORKDIR /app
ENV NODE_ENV=production NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
# Install all deps (incl. the Prisma CLI, a devDependency) so we can generate the
# Postgres client and run migrations. Prefer the lockfile; fall back to install.
RUN npm ci --include=dev --ignore-scripts || npm install --include=dev --ignore-scripts
COPY . .
# Generate the Prisma client for the Postgres production schema (the container's
# runtime DB): syncs prisma/schema.postgres.prisma, then generates the pg client.
# A dummy URL satisfies the config at generate time (generate doesn't connect).
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm run db:postgres:generate

# ── Runtime ──────────────────────────────────────────
FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=4000
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 app \
    && useradd  --system --uid 1001 --gid app --no-create-home --shell /usr/sbin/nologin app
COPY --from=builder --chown=app:app /app /app
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
    CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||4000) +'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]


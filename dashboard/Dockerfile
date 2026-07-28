# Multi-stage Dockerfile for ScopeCash AI dashboard (Vite build)
# Build → static assets served by nginx, dropping privileges.

FROM node:20-bookworm-slim AS builder
WORKDIR /app
# NODE_ENV is deliberately NOT set to production in this stage: npm skips
# devDependencies under it, and vite — the thing `npm run build` invokes — is
# a devDependency. Setting it here made every build of this image fail with
# exit 127 (command not found), which went unnoticed because the workflow
# that builds it only triggered on a branch that does not exist in this repo.
# The root Dockerfile's dashboard stage never set it, which is why that one
# has always worked. Only the runtime stage below needs production semantics,
# and nginx does not read NODE_ENV at all.
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package*.json ./
# Use the lockfile when present (reproducible); fall back to install when the
# dashboard ships only package.json (no lockfile).
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY . .
ARG REACT_APP_API_URL=/api
ENV REACT_APP_API_URL=$REACT_APP_API_URL
RUN npm run build

FROM nginx:1.27-alpine AS runtime
RUN addgroup -g 1001 -S app && adduser -S -G app -u 1001 app \
    && chown -R app:app /var/cache/nginx /var/log/nginx /etc/nginx /usr/share/nginx/html \
    && touch /var/run/nginx.pid && chown app:app /var/run/nginx.pid
COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]


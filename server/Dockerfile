# syntax=docker/dockerfile:1
# One image: the API server plus the admin dashboard it serves at "/".
# Build context is the repository root (see docker-compose.yml / deploy docs):
#   docker build -f server/Dockerfile -t slinger-server .

# ---- admin dashboard: static files only (admin-dashboard/dist) ----
# Debian (glibc) rather than Alpine: `npm ci` for linux/arm64 runs under QEMU when the image is published multi-arch, and
# Node on Alpine crashed there with "Illegal instruction".
FROM node:22-bookworm-slim AS dashboard
WORKDIR /app/admin-dashboard
# Dependency layer: only re-runs when the manifests change.
COPY admin-dashboard/package.json admin-dashboard/package-lock.json ./
RUN npm ci
COPY admin-dashboard/ ./
RUN npm run build

# ---- server ----
FROM node:22-bookworm-slim AS base
WORKDIR /app
# Prisma's query engine needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Production dependencies only (prisma CLI is a runtime dependency: it applies migrations on boot).
FROM base AS deps
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/prisma ./prisma
RUN npx prisma generate

# Compile TypeScript.
FROM base AS build
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/prisma ./prisma
RUN npx prisma generate
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
# Served at "/" (unset it to run the API only).
ENV SLINGER_DASHBOARD_DIR=/app/dashboard
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server/package.json ./
COPY server/prisma ./prisma
COPY server/docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=dashboard /app/admin-dashboard/dist ./dashboard
RUN chmod +x docker-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]

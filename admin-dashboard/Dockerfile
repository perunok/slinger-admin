# Build context is the repository root (see docker-compose.yml / deploy docs):
#   docker build -f admin-dashboard/Dockerfile -t slinger-admin-dashboard .
# Debian (glibc) rather than Alpine: `npm ci` for linux/arm64 runs under QEMU when the image is published multi-arch, and
# Node on Alpine crashed there with "Illegal instruction" (the server image, on bookworm-slim, built fine).
FROM node:22-bookworm-slim AS build
WORKDIR /app/admin-dashboard
# Dependency layer: only re-runs when the manifests change.
COPY admin-dashboard/package.json admin-dashboard/package-lock.json ./
RUN npm ci
# Source layer.
COPY admin-dashboard/ ./
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app/admin-dashboard
ENV NODE_ENV=production
COPY --from=build /app/admin-dashboard/package.json ./
COPY --from=build /app/admin-dashboard/dist ./dist
COPY --from=build /app/admin-dashboard/entrypoint.sh ./entrypoint.sh
# `vite preview` reads preview.allowedHosts (public hostname behind the proxy) from the config.
COPY --from=build /app/admin-dashboard/vite.config.ts /app/admin-dashboard/svelte.config.js ./
# `vite preview` serves dist/, so vite (a devDependency) must stay in the image.
COPY --from=build /app/admin-dashboard/node_modules ./node_modules
RUN chmod +x ./entrypoint.sh
EXPOSE 4173
CMD ["./entrypoint.sh"]

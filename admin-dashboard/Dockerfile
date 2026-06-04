FROM node:22-alpine AS build
WORKDIR /app/admin-dashboard
COPY admin-dashboard/package.json ./
COPY admin-dashboard ./
RUN npm install && npm run build

FROM node:22-alpine
WORKDIR /app/admin-dashboard
COPY --from=build /app/admin-dashboard ./
EXPOSE 4173
CMD ["npm", "run", "preview"]

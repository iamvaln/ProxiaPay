# The administration console: a Vite bundle served by nginx.
#
# NO BUILD ARGUMENTS, and that is a property worth keeping. The console's only
# call to the platform is `fetch(`/console${path}`)` — relative — so one image is
# correct in every environment. Baking a base URL in here, as the other projects
# on this VPS must, would mean a sandbox image that cannot be promoted and an
# image that silently talks to the wrong platform when it is.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/console/package.json apps/console/
RUN npm ci
COPY apps/console apps/console
RUN npm run build -w apps/console

FROM nginx:1.27-alpine AS runtime
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/console/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=6 --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

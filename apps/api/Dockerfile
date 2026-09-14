# The API image. One image, three commands: `node dist/main.js` serves,
# `node dist/main.worker.js` carries background work, and `node dist/cli/*.js`
# runs migrations, the seed and administrator creation (spec 15.1).
#
# `tsc -p tsconfig.build.json` compiles src/cli/* alongside the rest, so nothing
# here needs tsx or a TypeScript loader at runtime.

# ── Dependencies ────────────────────────────────────────────────────────────
# Installed from the lockfile alone, before any source is copied, so the layer
# survives every change that is not a dependency change.
FROM node:22-bookworm-slim AS deps
WORKDIR /src
COPY package.json package-lock.json ./
# BOTH workspace manifests: `npm ci` refuses to run against a lockfile whose
# workspaces it cannot find. The console's own runtime deps come along for the
# ride — five packages, a few megabytes — which is cheaper than teaching npm to
# install one workspace of a lockfile it insists on reading whole.
COPY apps/api/package.json apps/api/
COPY apps/console/package.json apps/console/
RUN npm ci
# Whether redoc hoists to the root or nests under the workspace depends on how its
# React range meets the console's. It hoists today; it nested before redoc 2.5.4, and
# a future dependency could nest it again. This keeps the directory present either way,
# so the runtime COPY below never fails on a resolution that simply went the other way.
RUN mkdir -p /src/apps/api/node_modules

# ── Build ───────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /src
COPY apps/api apps/api
RUN npm run build -w apps/api

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# THE LAYOUT IS LOAD-BEARING. migrate.ts and docs.module.ts resolve their files
# with join(__dirname, '..', '..', …) — from dist/cli and dist/docs that lands on
# the package root. Flattening dist/ to /app would send both lookups to /.
WORKDIR /app/apps/api
COPY --from=deps /src/node_modules /app/node_modules
# The workspace's own node_modules, when npm nests anything there rather than hoisting
# it (redoc did, before 2.5.4). Empty today; copied regardless, because the alternative
# is an image that loses a package at runtime whenever resolution changes.
COPY --from=deps /src/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /src/apps/api/dist ./dist
COPY apps/api/migrations ./migrations
COPY apps/api/assets ./assets
COPY apps/api/package.json ./package.json
COPY package.json /app/package.json
USER node
EXPOSE 3000
# The image carries its own probe so Compose inherits it without repeating it.
# /healthz takes no dependencies, so this reports on the process and nothing else.
HEALTHCHECK --interval=10s --timeout=5s --retries=12 --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/main.js"]

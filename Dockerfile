# ── Stage 1: base ────────────────────────────────────────────────────
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
RUN apk add --no-cache postgresql-client
WORKDIR /app
# Copy only package files first for layer caching
COPY package.json package-lock.json* ./

# ── Stage 2: deps ───────────────────────────────────────────────────
FROM base AS deps
RUN npm ci --ignore-scripts && npm cache clean --force

# ── Stage 3: build ──────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc -p .

# ── Stage 4: production ─────────────────────────────────────────────
FROM base AS prod
ENV NODE_ENV=production

# Use the non-root `node` user that ships with the official image (uid 1000).
# Writable data dir for first-boot generated secrets.
RUN mkdir -p /app/data && chown node:node /app/data

# Copy only production node_modules (pruned)
COPY --from=deps /app/node_modules ./node_modules

# Copy compiled JS from build
COPY --from=build /app/dist ./dist

# Copy drizzle SQL migrations (needed at runtime for migrate.ts)
COPY drizzle/ ./drizzle/

# Copy acceptance fixtures + seeder (needed at runtime for seed-fixtures.mjs)
COPY stuff/fixtures.json ./fixtures.json
COPY docker/seed-fixtures.mjs ./docker/seed-fixtures.mjs

# Copy official fixtures (needed at runtime for seed-fixtures.js)
COPY stuff/fixtures.json ./stuff/fixtures.json

# Copy templates + static assets (needed at runtime, not compiled by tsc)
COPY templates/ ./templates/
COPY static/ ./static/

# Copy entrypoint
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Writable data dir for first-boot generated secrets (owned by node)
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

# Copy package.json (for npm start script)
COPY package.json ./

# Healthcheck: hit /healthz via 127.0.0.1 (localhost can resolve to ::1
# first in this image, and the server binds IPv4 — localhost probes got
# ECONNREFUSED while 127.0.0.1 answered fine).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

EXPOSE 3000

USER node

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server.js"]

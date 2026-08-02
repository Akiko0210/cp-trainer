# The Next app. Multi-stage so the shipped image carries the server and its
# assets — not the toolchain that produced them.

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time only: nothing here is baked into the image, but `next build`
# imports instrumentation.ts, which refuses to start without the production
# variables. The real ones arrive at runtime.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
# HOSTNAME matters: Docker sets it to the container id, and the standalone
# server binds to whatever HOSTNAME says — so without this it listens on the
# container's own name and nothing reaches it on 127.0.0.1, which silently
# fails every health check while the app itself looks fine.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# Don't run as root: a web process that is compromised should not also own the
# filesystem it is running on.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# `output: "standalone"` (next.config.ts) emits a server plus exactly the
# node_modules it traced — the difference between ~150MB and ~1GB.
#
# No `COPY /app/public` here, deliberately. This app has no public/ directory:
# the icons live in src/app (favicon.ico, icon.svg, apple-icon.png), which the
# App Router serves itself, and nothing else references a static asset. Git
# cannot track an empty directory, so the line the Next.js template ships with
# fails on every fresh clone with "path not found" — it only appeared to work
# on a laptop that still had the empty folder create-next-app left behind.
# Restore it if you ever add something under public/.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Schema and migration runner travel with the image so a deploy can bring the
# database up to date with the code that needs it. `pg` is already inside the
# standalone bundle — the app imports it, so the build traced it.
COPY --from=builder --chown=nextjs:nodejs /app/db ./db
COPY --from=builder --chown=nextjs:nodejs /app/scripts/migrate.mjs ./scripts/migrate.mjs

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]

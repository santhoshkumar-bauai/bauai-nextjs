# syntax=docker/dockerfile:1.7

# Production image for the Next.js web app — and only the web app. The ingestion
# and document workers keep their own images under docker/; nothing in here runs
# a queue consumer or a cron entrypoint.
#
#   docker build -t bau-ai-web .
#   docker run --rm -p 3000:3000 --env-file .env.prod bau-ai-web
#
# Built on Debian slim rather than Alpine because the web process launches headless
# Chromium for PDF report export (lib/ai/report/render-pdf.ts) and Playwright ships
# no Alpine build. Pass --build-arg WITH_CHROMIUM=false to drop Chromium and roughly
# half the image size; PDF export then returns PdfUnavailableError while DOCX export
# (pure JS) keeps working.

# ---------- deps: full install, dev deps included ----------
FROM node:24-bookworm-slim AS deps

WORKDIR /app

# The runtime stage installs Chromium once into a shared path; skip the per-package
# download that Playwright's postinstall would otherwise do here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
# `npm install` (not `npm ci`) so the Linux-native optional binaries — sharp,
# lightningcss, the SWC and Turbopack targets — resolve for this platform. The
# committed lock is generated on Windows and omits them, which makes strict
# `npm ci` fail in this image. Dev dependencies stay: `next build` needs
# TypeScript and Tailwind. The cache mount keeps ~/.npm across builds and lives
# outside the layer, so no `npm cache clean` is needed to keep the image small.
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm install --no-audit --no-fund

# ---------- build: next build -> .next/standalone ----------
FROM node:24-bookworm-slim AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so they
# must be present now — setting them at run time has no effect. Both are public
# Google Maps browser keys (restrict them by HTTP referrer), not secrets; no
# server-side secret is needed to build.
ARG NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=""
ARG NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=""
ENV NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY \
    NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=$NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID

# Build-only placeholders — NOT configuration, and never carried into the runtime
# stage. "Collecting page data" imports every route module, and two modules assert
# on env at import time rather than on first use: lib/db/mongodb.ts throws without
# MONGODB_URI, and better-auth throws without a secret when NODE_ENV=production
# (which `next build` sets). No route is prerendered — the whole app is
# server-rendered on demand — so nothing here is ever dialled or signed with, and
# only NEXT_PUBLIC_* values get inlined into the bundle. The real MONGODB_URI and
# BETTER_AUTH_SECRET are read from the environment at run time.
ENV MONGODB_URI=mongodb://build-time-placeholder:27017/bauai \
    BETTER_AUTH_SECRET=build-time-placeholder-not-a-real-secret

# Persisting .next/cache across builds is what makes `next build` incremental —
# it is a build artifact only; nothing from this mount lands in the image.
RUN --mount=type=cache,id=next-build,target=/app/.next/cache \
    npm run build

# ---------- runtime ----------
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=1536 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# dumb-init makes PID 1 forward SIGTERM, so in-flight requests drain on `docker stop`
# instead of the process being killed outright.
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ===== Everything from here to the standalone COPY is keyed on package-lock.json
# only. Playwright is pulled from `deps`, not `builder`, so a source-only change
# cannot invalidate the Chromium layer below — previously it sat after the .next
# copies and re-downloaded Chromium on every deploy.
COPY --from=deps /app/node_modules/playwright ./node_modules/playwright
COPY --from=deps /app/node_modules/playwright-core ./node_modules/playwright-core

ARG WITH_CHROMIUM=true
# Installed from the locked package (not `npx playwright`, which would fetch the
# latest CLI and a browser revision that playwright-core here cannot drive), and
# made world-readable so the unprivileged `node` user can launch it.
RUN if [ "$WITH_CHROMIUM" = "true" ]; then \
      node node_modules/playwright/cli.js install --with-deps chromium \
      && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH" \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# ===== Everything below changes on every commit — keep it last. =====
# The standalone bundle ships its own minimal node_modules (only the files the
# server actually traced). `public` and `.next/static` are deliberately left out
# of it by the build and have to be copied in beside it. Tracing copies a strict
# subset of byte-identical files from the same node_modules, so landing standalone
# on top of the full playwright packages above is a no-op overwrite — the ~2 MB of
# playwright-core files that tracing drops (resolved at run time by the driver)
# survive underneath.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Next writes its response/ISR cache under .next/cache at run time.
RUN mkdir -p .next/cache && chown -R node:node .next

# The image ships no .env: MONGODB_URI, REDIS_URL, BETTER_AUTH_SECRET, S3_*, and the
# model API keys all come from the orchestrator's secret store at run time.
USER node

EXPOSE 3000

# Any HTTP answer below 500 means the server is up; `/` legitimately redirects to
# sign-in or onboarding depending on session state, so redirects are not followed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]

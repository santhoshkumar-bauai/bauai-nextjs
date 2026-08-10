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
# TypeScript and Tailwind.
RUN npm install --no-audit --no-fund && npm cache clean --force

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

RUN npm run build

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

# The standalone bundle ships its own minimal node_modules (only the files the
# server actually traced). `public` and `.next/static` are deliberately left out
# of it by the build and have to be copied in beside it.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Playwright is reached through a dynamic `import("playwright")` on the export
# path, which file tracing does not reliably follow — copy the packages whole.
COPY --from=builder /app/node_modules/playwright ./node_modules/playwright
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core

ARG WITH_CHROMIUM=true
# Installed from the locked package (not `npx playwright`, which would fetch the
# latest CLI and a browser revision that playwright-core here cannot drive), and
# made world-readable so the unprivileged `node` user can launch it.
RUN if [ "$WITH_CHROMIUM" = "true" ]; then \
      node node_modules/playwright/cli.js install --with-deps chromium \
      && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH" \
      && rm -rf /var/lib/apt/lists/*; \
    fi

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

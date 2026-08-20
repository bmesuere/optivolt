# Home Assistant passes BUILD_FROM automatically when building from this repo.
# Default to the official Home Assistant base image based on architecture.
# Pinned to a concrete tag (Alpine 3.24, docker-base release 2026.06.1)
# rather than `:latest`: an unpinned tag ties our Node version (installed
# below via `apk add nodejs`, unpinned since exact Alpine package versions
# are brittle across releases) to whatever Alpine happens to ship on the
# day of the build. If that ever drops below the Node version we need for
# TypeScript type stripping (>=22.18), the add-on fails to boot with a
# confusing parse error that's invisible to CI. Bump this deliberately when
# updating.
# The pin lives on the literal FROM line below because Dependabot can only
# bump a literal `FROM image:tag`, never an ARG-based one. The HA builder
# still overrides the base per architecture via BUILD_FROM; local and CI
# builds fall through to this pinned amd64 stage.
ARG BUILD_FROM=default-base
FROM ghcr.io/home-assistant/amd64-base:3.24-2026.06.1 AS default-base

FROM $BUILD_FROM

# Minimal runtime env
ENV \
  S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
  NODE_ENV=production

# We need Node to run the Express server.
# The base is Alpine; install node & npm.
RUN apk add --no-cache nodejs npm curl

# Workdir for the app
WORKDIR /opt/optivolt

# Copy only what we need (smaller image, faster build)
COPY package.json package-lock.json* ./
COPY app ./app
COPY api ./api
COPY lib ./lib
COPY vendor/highs-build ./vendor/highs-build

# Install deps, build/mirror shared code into /app, then prune dev deps
RUN npm ci \
  && npm prune --omit=dev

# s6-overlay service + init hooks
COPY addon/rootfs/ /

# Healthcheck for the Supervisor/watchdog
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fs http://127.0.0.1:3000/health || exit 1

EXPOSE 3000

# Home Assistant passes BUILD_FROM automatically when building from this repo.
# Default to the official Home Assistant base image based on architecture.
ARG BUILD_ARCH=amd64
ARG BUILD_FROM=ghcr.io/home-assistant/${BUILD_ARCH}-base:latest
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

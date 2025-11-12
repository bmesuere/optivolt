#!/usr/bin/with-contenv bashio
# Ensure the persistent data dir exists and is writable
set -euo pipefail
bashio::log.info "Initializing Optivolt data dir"
mkdir -p /data

#!/bin/sh
set -eu

# At container start, rewrite config.json from env vars so we can retarget the
# API without rebuilding the image. Defaults come from the baked public/config.json.
CONFIG_FILE=/usr/share/nginx/html/config.json
API_BASE_URL=${API_BASE_URL:-}

if [ -n "$API_BASE_URL" ]; then
  printf '{"apiBaseUrl":"%s"}\n' "$API_BASE_URL" > "$CONFIG_FILE"
  echo "[entrypoint] Wrote API_BASE_URL=$API_BASE_URL to $CONFIG_FILE"
else
  echo "[entrypoint] API_BASE_URL not set; using baked $CONFIG_FILE"
fi

exec "$@"

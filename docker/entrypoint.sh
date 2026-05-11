#!/bin/sh
set -eu

# At container start, rewrite config.json from env vars so we can retarget the
# API + bake build metadata without rebuilding the image. Defaults come from
# the baked public/config.json. Optional fields are omitted from the rewritten
# JSON when their env var is unset, so the operator gets minimal noise.
CONFIG_FILE=/usr/share/nginx/html/config.json
API_BASE_URL=${API_BASE_URL:-}
APP_VERSION=${APP_VERSION:-}
BUILD_SHA=${BUILD_SHA:-}
BUILD_TIME=${BUILD_TIME:-}
ENVIRONMENT_LABEL=${ENVIRONMENT_LABEL:-}

# Build a JSON object piece by piece. Only emit keys whose env var is non-empty.
# Using printf + manual JSON construction (no jq dependency) — values are
# operator-controlled strings, so we escape double-quotes defensively.
escape() {
  printf '%s' "$1" | sed 's/"/\\"/g; s/\\/\\\\/g'
}

if [ -n "$API_BASE_URL" ] \
   || [ -n "$APP_VERSION" ] \
   || [ -n "$BUILD_SHA" ] \
   || [ -n "$BUILD_TIME" ] \
   || [ -n "$ENVIRONMENT_LABEL" ]; then
  sep=""
  printf '{' > "$CONFIG_FILE"
  if [ -n "$API_BASE_URL" ]; then
    printf '%s"apiBaseUrl":"%s"' "$sep" "$(escape "$API_BASE_URL")" >> "$CONFIG_FILE"; sep=","
  fi
  if [ -n "$APP_VERSION" ]; then
    printf '%s"appVersion":"%s"' "$sep" "$(escape "$APP_VERSION")" >> "$CONFIG_FILE"; sep=","
  fi
  if [ -n "$BUILD_SHA" ]; then
    printf '%s"buildSha":"%s"' "$sep" "$(escape "$BUILD_SHA")" >> "$CONFIG_FILE"; sep=","
  fi
  if [ -n "$BUILD_TIME" ]; then
    printf '%s"buildTime":"%s"' "$sep" "$(escape "$BUILD_TIME")" >> "$CONFIG_FILE"; sep=","
  fi
  if [ -n "$ENVIRONMENT_LABEL" ]; then
    printf '%s"environmentLabel":"%s"' "$sep" "$(escape "$ENVIRONMENT_LABEL")" >> "$CONFIG_FILE"; sep=","
  fi
  printf '}\n' >> "$CONFIG_FILE"
  echo "[entrypoint] Wrote runtime config to $CONFIG_FILE (API_BASE_URL=${API_BASE_URL:-baked}, SHA=${BUILD_SHA:-none})"
else
  echo "[entrypoint] No runtime overrides set; using baked $CONFIG_FILE"
fi

exec "$@"

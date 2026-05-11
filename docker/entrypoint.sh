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
SENTRY_DSN=${SENTRY_DSN:-}
SENTRY_ENVIRONMENT=${SENTRY_ENVIRONMENT:-}
SENTRY_RELEASE=${SENTRY_RELEASE:-}
SENTRY_TRACES_SAMPLE_RATE=${SENTRY_TRACES_SAMPLE_RATE:-}
SENTRY_REPLAYS_SESSION_SAMPLE_RATE=${SENTRY_REPLAYS_SESSION_SAMPLE_RATE:-}
SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE=${SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE:-}

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
   || [ -n "$ENVIRONMENT_LABEL" ] \
   || [ -n "$SENTRY_DSN" ] \
   || [ -n "$SENTRY_ENVIRONMENT" ] \
   || [ -n "$SENTRY_RELEASE" ] \
   || [ -n "$SENTRY_TRACES_SAMPLE_RATE" ] \
   || [ -n "$SENTRY_REPLAYS_SESSION_SAMPLE_RATE" ] \
   || [ -n "$SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE" ]; then
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
  if [ -n "$SENTRY_DSN" ]; then
    printf '%s"sentryDsn":"%s"' "$sep" "$(escape "$SENTRY_DSN")" >> "$CONFIG_FILE"; sep=","
  fi
  if [ -n "$SENTRY_ENVIRONMENT" ]; then
    printf '%s"sentryEnvironment":"%s"' "$sep" "$(escape "$SENTRY_ENVIRONMENT")" >> "$CONFIG_FILE"; sep=","
  fi
  if [ -n "$SENTRY_RELEASE" ]; then
    printf '%s"sentryRelease":"%s"' "$sep" "$(escape "$SENTRY_RELEASE")" >> "$CONFIG_FILE"; sep=","
  fi
  # Numeric sample-rate fields emit as JSON numbers (not strings) — operators
  # set these to floats like 0.05 so they must parse as numbers at the client.
  if [ -n "$SENTRY_TRACES_SAMPLE_RATE" ]; then
    printf '%s"sentryTracesSampleRate":%s' "$sep" "$SENTRY_TRACES_SAMPLE_RATE" >> "$CONFIG_FILE"; sep=","
  fi
  if [ -n "$SENTRY_REPLAYS_SESSION_SAMPLE_RATE" ]; then
    printf '%s"sentryReplaysSessionSampleRate":%s' "$sep" "$SENTRY_REPLAYS_SESSION_SAMPLE_RATE" >> "$CONFIG_FILE"; sep=","
  fi
  if [ -n "$SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE" ]; then
    printf '%s"sentryReplaysOnErrorSampleRate":%s' "$sep" "$SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE" >> "$CONFIG_FILE"; sep=","
  fi
  printf '}\n' >> "$CONFIG_FILE"
  echo "[entrypoint] Wrote runtime config to $CONFIG_FILE (API_BASE_URL=${API_BASE_URL:-baked}, SHA=${BUILD_SHA:-none}, SENTRY=${SENTRY_DSN:+on})"
else
  echo "[entrypoint] No runtime overrides set; using baked $CONFIG_FILE"
fi

exec "$@"

#!/usr/bin/env bash
# docker-prune.sh — weekly cleanup of Docker build cache + dangling images.
# Triggered by ~/Library/LaunchAgents/com.lascodia.docker-prune.plist.
# Volumes (incl. lascodia-trading-engine_pgdata) are NEVER touched.
# See: lascodia-trading-engine/docs/runbooks/docker-disk-bloat.md

set -euo pipefail

LOG="${DOCKER_PRUNE_LOG:-/tmp/docker-prune.log}"
RAW=~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw

ts() { date +%Y-%m-%dT%H:%M:%S; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

if ! docker info >/dev/null 2>&1; then
  log "docker daemon not reachable, skipping prune"
  exit 0
fi

BEFORE=$(du -h "$RAW" 2>/dev/null | cut -f1 || echo "?")
log "starting prune (Docker.raw=$BEFORE)"

if docker builder prune -af >>"$LOG" 2>&1; then
  log "builder prune ok"
else
  log "builder prune failed (continuing)"
fi

if docker image prune -f >>"$LOG" 2>&1; then
  log "image prune ok"
else
  log "image prune failed (continuing)"
fi

AFTER=$(du -h "$RAW" 2>/dev/null | cut -f1 || echo "?")
log "done (Docker.raw=$BEFORE -> $AFTER)"

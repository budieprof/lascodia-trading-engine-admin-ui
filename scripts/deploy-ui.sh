#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Production deploy of the console on the hosting Mac (mac2) — the admin-UI twin of the engine's
# deploy/prod-host/deploy-engine.sh. Run by the self-hosted runner on every push to main
# (.github/workflows/deploy-prod.yml, which copies THIS file out of the target commit first), or by hand:
#
#   scripts/deploy-ui.sh <commit>                  # publish that main commit's laptop-built bundle
#   scripts/deploy-ui.sh <commit> --force          # even if it is already live / no bundle input changed
#   scripts/deploy-ui.sh <commit> --build-on-host  # FALLBACK: npm ci + ng build HERE (≈3.6 GB node spike — mac2 has
#                                                  # kernel-panicked under memory pressure; use only when the laptop
#                                                  # cannot ship). Also LASCODIA_UI_BUILD_ON_HOST=1.
#   scripts/deploy-ui.sh --rollback                # previous release (release.sh rollback)
#   scripts/deploy-ui.sh --status                  # release.sh status
#
# THE BUNDLE IS BUILT ON THE DEV LAPTOP (scripts/ship-release.sh <commit>): lascodia-admin-<sha8>.tar.gz + .sha256 in
# $LASCODIA_UI_BUNDLES (default ~/lascodia-prod/state/ui-bundles). This script waits up to
# LASCODIA_UI_PREBUILT_WAIT_MIN (30) minutes for it; none by then → exit 1, NOTHING changed live.
#
# Steps: refuse anything not on origin/main; skip commits older than the live bundle (out-of-order runs); skip commits
# that change no bundle input since the live one (src public angular.json package*.json tsconfig*.json — same list as
# release.sh status); wait for the bundle; check out the commit in the production checkout (release.sh stamps
# config.json from ITS public/config.json — the feature flags); release.sh publish --bundle (stamp → stage → atomic
# swap → verify by releaseId; a failed verify swaps the previous release back).
# Exit: 0 published / skipped, 1 failed or no bundle (live untouched), 2 refused.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

export PATH="/opt/homebrew/opt/node@24/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

UI_DIR="${LASCODIA_UI_DIR:-$HOME/lascodia-prod/lascodia-trading-engine-admin-ui}"
BUNDLES="${LASCODIA_UI_BUNDLES_DIR:-$HOME/lascodia-prod/state/ui-bundles}"
WAIT_MIN="${LASCODIA_UI_PREBUILT_WAIT_MIN:-30}"
BUILD_ON_HOST="${LASCODIA_UI_BUILD_ON_HOST:-0}"
ORIGIN="${LASCODIA_UI_ORIGIN:-http://localhost:8080}"
BRANCH=main
BUNDLE_INPUTS=(src public angular.json package.json package-lock.json tsconfig.json tsconfig.app.json)

ts()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s  %s\n' "$(ts)" "$*"; }
die() { log "FAILED: $*"; exit 1; }

MODE=deploy FORCE=0 TARGET=""
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --build-on-host) BUILD_ON_HOST=1 ;;
    --rollback) MODE=rollback ;;
    --status) MODE=status ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    -*) echo "unknown option $a" >&2; exit 2 ;;
    *) TARGET="$a" ;;
  esac
done

cd "$UI_DIR"
case "$MODE" in
  status)   scripts/release.sh status; exit 0 ;;
  rollback) scripts/release.sh rollback; scripts/release.sh status; exit 0 ;;
esac

git fetch --quiet --prune origin
SHA=$(git rev-parse --verify "${TARGET:-origin/$BRANCH}^{commit}") || { log "unknown commit ${TARGET:-origin/$BRANCH}"; exit 2; }
REV=${SHA:0:8}
git merge-base --is-ancestor "$SHA" "origin/$BRANCH" || { log "$REV is not on origin/$BRANCH — production deploys only $BRANCH"; exit 2; }

# What is live (the buildSha the origin serves; "-dirty" only ever came from a hand publish).
LIVE=$(curl -fsS -m 5 "$ORIGIN/config.json" 2>/dev/null | sed -n 's/.*"buildSha": *"\([0-9a-f]*\).*/\1/p' || true)
if [[ -n "$LIVE" && $FORCE == 0 ]] && git cat-file -e "$LIVE^{commit}" 2>/dev/null; then
  if [[ "$(git rev-parse "$LIVE")" == "$SHA" ]]; then log "$REV is already live"; exit 0; fi
  if git merge-base --is-ancestor "$SHA" "$LIVE"; then log "live $LIVE is newer than $REV — nothing to do"; exit 0; fi
  if git diff --quiet "$LIVE" "$SHA" -- "${BUNDLE_INPUTS[@]}"; then
    log "$REV changes no bundle input since the live $LIVE — nothing to publish (scripts/tests/docs only)"
    exit 0
  fi
fi

BUNDLE="$BUNDLES/lascodia-admin-$REV.tar.gz"
if (( BUILD_ON_HOST )); then
  log "FALLBACK: building on this host (--build-on-host) — npm ci + ng build, ~3.6 GB node peak"
else
  deadline=$((SECONDS + WAIT_MIN * 60)) next=0
  until [[ -f "$BUNDLE" && -f "$BUNDLE.sha256" ]]; do
    if (( SECONDS >= deadline )); then
      die "no laptop-built bundle $BUNDLE after $WAIT_MIN min — nothing changed live. Run on the dev laptop: scripts/ship-release.sh $REV, then re-run this deploy (gh run rerun, or workflow_dispatch)"
    fi
    if (( SECONDS >= next )); then
      log "waiting for the laptop-built bundle $(basename "$BUNDLE") — run on the dev laptop: scripts/ship-release.sh $REV"
      next=$((SECONDS + 300))
    fi
    sleep 15
  done
  log "bundle $(basename "$BUNDLE") has arrived"
fi

# The checkout moves to the commit: release.sh stamps config.json from its public/config.json (feature flags).
git checkout --quiet --detach "$SHA"
git reset --quiet --hard && git clean -fdq -e node_modules -e dist

if (( BUILD_ON_HOST )); then
  LOCK_HASH=$(shasum package-lock.json | cut -c1-40)
  if [[ "$(cat node_modules/.lock-hash 2>/dev/null)" != "$LOCK_HASH" ]]; then
    npm ci --no-audit --no-fund
    echo "$LOCK_HASH" > node_modules/.lock-hash
  fi
  scripts/release.sh publish
else
  scripts/release.sh publish --bundle "$BUNDLE" --expect-sha "$SHA"
fi
scripts/release.sh status

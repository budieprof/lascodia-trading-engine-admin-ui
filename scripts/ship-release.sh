#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build the console's production bundle ON THE DEV LAPTOP and copy it to mac2 — the admin-UI twin of the engine's
# deploy/prod-host/ship-image.sh. mac2 does not run `ng build` any more: the ~3.6 GB node spike under memory pressure is
# what kernel-panics it (Rosetta page-lock deadlock, 2026-11). scripts/deploy-ui.sh on mac2 (run by
# .github/workflows/deploy-prod.yml on every push to main) waits for the bundle this script ships, then publishes it
# with `scripts/release.sh publish --bundle` (stamp → stage → atomic swap → verify by releaseId, rollback unchanged).
#
#   scripts/ship-release.sh                    # build + ship origin/main
#   scripts/ship-release.sh <commit>           # a specific main commit
#   scripts/ship-release.sh HEAD --unpushed    # build BEFORE pushing (the deploy then publishes at once)
#   scripts/ship-release.sh <commit> --force   # rebuild + reship although mac2 already has it
#   scripts/ship-release.sh <commit> --no-ship # build + package only (no mac2 needed)
#
# What it does:
#   1. resolves the commit (must be on origin/main unless --unpushed); skips it when mac2 already holds the bundle;
#   2. exports the commit into a CLEAN temporary worktree (your working copy and its uncommitted changes never reach
#      production) and installs dependencies with `npm ci` from the npm cache;
#   3. runs `ng build --configuration production` — THE deploy gate (budgets, prod-only AOT errors) — under the
#      laptop's heavy-job lock (/tmp/lascodia-heavy.sh) when it exists;
#   4. packages dist/lascodia-admin/browser + manifest.json (commit sha, build time, node version) as
#      lascodia-admin-<sha8>.tar.gz with a .sha256 beside it;
#   5. copies both to mac2:$LASCODIA_UI_BUNDLES (default ~/lascodia-prod/state/ui-bundles) under a temporary name,
#      renames them into place only after the checksum matches there.
# Then push the commit (if not yet pushed): the deploy on mac2 finds the bundle and publishes it.
# The config.json stamping (apiBaseUrl, buildSha, releaseId, feature flags) still happens on mac2 at publish time.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HOST="${LASCODIA_PROD_HOST:-mac2}"
REMOTE_DIR="${LASCODIA_UI_BUNDLES:-lascodia-prod/state/ui-bundles}"   # relative to the remote $HOME
REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT_DIR="${LASCODIA_UI_SHIP_DIR:-${TMPDIR:-/tmp}/lascodia-ui-ship}"
BRANCH=main
mkdir -p "$OUT_DIR"

ts()  { date -u +%H:%M:%SZ; }
log() { printf '%s  %s\n' "$(ts)" "$*"; }
die() { log "FAILED: $*"; exit 1; }
remote() { ssh -o ConnectTimeout=15 "$HOST" "export PATH=/usr/local/bin:/opt/homebrew/bin:\$PATH; $*"; }

REF="" UNPUSHED=0 FORCE=0 SHIP=1
for a in "$@"; do
  case "$a" in
    --unpushed) UNPUSHED=1 ;;
    --force) FORCE=1 ;;
    --no-ship) SHIP=0 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    -*) echo "unknown option $a" >&2; exit 2 ;;
    *) REF="$a" ;;
  esac
done
REF="${REF:-origin/$BRANCH}"

# One heavy job at a time on the 16 GB laptop (ng build is one).
HEAVY_LOCK=/tmp/lascodia-heavy.sh
if [[ -x "$HEAVY_LOCK" && -z "${LASCODIA_HEAVY_HELD:-}" ]]; then
  export LASCODIA_HEAVY_HELD=1
  log "waiting for the heavy-job lock ($HEAVY_LOCK)"
  exec "$HEAVY_LOCK" bash "$0" "$@"
fi

command -v node >/dev/null || die "node is not installed on this machine"

# 1. the commit
git -C "$REPO" fetch --quiet origin || log "WARNING: git fetch failed — using the refs this clone already has"
SHA=$(git -C "$REPO" rev-parse --verify "$REF^{commit}") || die "unknown commit $REF"
REV=${SHA:0:8}
if ! git -C "$REPO" merge-base --is-ancestor "$SHA" "origin/$BRANCH"; then
  (( UNPUSHED )) || die "$REV is not on origin/$BRANCH — push it first, or pass --unpushed to build it ahead of the push"
  log "$REV is not on origin/$BRANCH yet — mac2 publishes it once it is pushed"
fi
log "commit $REV — $(git -C "$REPO" log -1 --format=%s "$SHA" | cut -c1-90)"

NAME="lascodia-admin-$REV.tar.gz"
if (( SHIP )) && (( ! FORCE )); then
  if remote "cd \"\$HOME/$REMOTE_DIR\" 2>/dev/null && shasum -a 256 -c $NAME.sha256 >/dev/null 2>&1"; then
    log "$HOST already holds $REMOTE_DIR/$NAME (checksum OK) — nothing to do (--force to reship)"
    exit 0
  fi
fi

# 2. a clean tree: the commit, nothing from the working copy
TMP=$(mktemp -d "${TMPDIR:-/tmp}/lascodia-ui-ship-$REV.XXXXXX")
cleanup() { git -C "$REPO" worktree remove --force "$TMP/src" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
git -C "$REPO" worktree add --detach --quiet "$TMP/src" "$SHA"

LOG="$OUT_DIR/$REV-$(date -u +%Y%m%dT%H%M%SZ).build.log"
log "npm ci (log: $LOG)"
START=$SECONDS
(cd "$TMP/src" && npm ci --prefer-offline --no-audit --no-fund) > "$LOG" 2>&1 || { tail -n 30 "$LOG"; die "npm ci failed"; }
log "dependencies in $((SECONDS - START)) s"

# 3. the production build — the deploy gate
log "ng build --configuration production"
START=$SECONDS
(cd "$TMP/src" && npm run build -- --configuration production) >> "$LOG" 2>&1 \
  || { tail -n 40 "$LOG"; die "production build failed — nothing was shipped (log: $LOG)"; }
[[ -f "$TMP/src/dist/lascodia-admin/browser/index.html" ]] || die "the build produced no dist/lascodia-admin/browser/index.html"
log "built in $((SECONDS - START)) s"

# 4. package
PKG="$TMP/pkg"
mkdir -p "$PKG"
mv "$TMP/src/dist/lascodia-admin/browser" "$PKG/browser"
SHA="$SHA" BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" BUILDER="$(hostname -s)" node -e '
  const fs = require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({
    sha: process.env.SHA, builtAt: process.env.BUILT_AT, builder: process.env.BUILDER,
    node: process.version, configuration: "production",
  }, null, 2) + "\n");' "$PKG/manifest.json"
tar -czf "$OUT_DIR/$NAME" -C "$PKG" manifest.json browser
(cd "$OUT_DIR" && shasum -a 256 "$NAME" > "$NAME.sha256")
log "packaged $OUT_DIR/$NAME ($(du -h "$OUT_DIR/$NAME" | cut -f1))"
# keep the newest five bundles on this machine
ls -t "$OUT_DIR"/lascodia-admin-*.tar.gz 2>/dev/null | tail -n +6 | while read -r f; do rm -f "$f" "$f.sha256"; done

(( SHIP )) || { log "built only (--no-ship)"; exit 0; }

# 5. ship: temporary names, verify the checksum THERE, then rename into place (the deploy never sees half a file)
log "shipping to $HOST:$REMOTE_DIR"
remote "mkdir -p \"\$HOME/$REMOTE_DIR\"" || die "cannot reach $HOST over ssh"
scp -q -o ConnectTimeout=15 "$OUT_DIR/$NAME" "$HOST:$REMOTE_DIR/.partial-$NAME" || die "copy to $HOST failed"
scp -q -o ConnectTimeout=15 "$OUT_DIR/$NAME.sha256" "$HOST:$REMOTE_DIR/.partial-$NAME.sha256" || die "copy to $HOST failed"
remote "cd \"\$HOME/$REMOTE_DIR\" \
  && [ \"\$(cut -d' ' -f1 .partial-$NAME.sha256)\" = \"\$(shasum -a 256 .partial-$NAME | cut -d' ' -f1)\" ] \
  && mv -f .partial-$NAME.sha256 $NAME.sha256 && mv -f .partial-$NAME $NAME \
  && ls -t lascodia-admin-*.tar.gz | tail -n +11 | while read -r f; do rm -f \"\$f\" \"\$f.sha256\"; done" \
  || die "checksum on $HOST does not match — nothing was put in place"
log "on $HOST: $REMOTE_DIR/$NAME"
if git -C "$REPO" merge-base --is-ancestor "$SHA" "origin/$BRANCH"; then
  log "done — the deploy of $REV on $HOST publishes this bundle (watch: gh run watch -R budieprof/lascodia-trading-engine-admin-ui)"
else
  log "done — now push $REV to $BRANCH; the deploy on $HOST publishes this bundle"
fi

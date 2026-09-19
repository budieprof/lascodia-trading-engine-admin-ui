#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Publish the admin UI as a COMPILED BUNDLE, decoupled from development.
#
# WHY THIS EXISTS
# ---------------
# Until 2026-09-19 the live console (https://app.codiapay.com, via cloudflared →
# Caddy :8080) was served by the Angular DEV SERVER: Caddy's catch-all proxied
# to `ng serve` on :4200.  Consequences:
#
#   * every source edit rebuilt and hot-reloaded the LIVE operator console —
#     a half-finished component could brick the dashboard mid-trading-session;
#   * the live UI was an unoptimised dev build (no minification, no budgets,
#     source maps served publicly);
#   * it depended on one hand-started `npm start` process.  Kill the terminal,
#     reboot the Mac, and the console was gone until someone noticed;
#   * `ng build --configuration production` was never on the path, which is
#     exactly how the production build stayed RED for three days in Sep 2026.
#
# Now: a production build is compiled, stamped with its git SHA, staged into an
# immutable release directory, and swapped in atomically.  Caddy serves those
# static files directly — no Node process in the serving path at all, so the
# console survives reboots and is completely unaffected by `ng serve`.
#
# LAYOUT (outside the git tree — a release must not be mutable by a checkout)
#
#   /opt/homebrew/var/www/lascodia-admin/
#     releases/20260919-120500-f166042/   ← immutable, one per publish
#     releases/20260919-143000-a1b2c3d/
#     current -> releases/20260919-143000-a1b2c3d   ← Caddy's root
#
# The `current` symlink is swapped with rename(2), so a request either sees the
# whole old release or the whole new one — never a half-copied directory.  Caddy
# resolves the symlink per request, so no reload is needed to go live.
#
# USAGE
#   scripts/release.sh publish [--no-verify]   build → stamp → stage → swap → verify
#   scripts/release.sh rollback [<release>]    swap back (default: previous)
#   scripts/release.sh list                    releases on disk, newest first
#   scripts/release.sh status                  what is LIVE vs what is checked out
#
# ENV OVERRIDES
#   LASCODIA_UI_WEBROOT   publish root          (default /opt/homebrew/var/www/lascodia-admin)
#   LASCODIA_UI_ORIGIN    origin to verify      (default http://localhost:8080)
#   LASCODIA_UI_KEEP      releases to retain    (default 5)
#   API_BASE_URL          baked into config.json (default "" = same-origin via Caddy /api/*)
#   ENVIRONMENT_LABEL     footer pill label     (default production)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBROOT="${LASCODIA_UI_WEBROOT:-/opt/homebrew/var/www/lascodia-admin}"
ORIGIN="${LASCODIA_UI_ORIGIN:-http://localhost:8080}"
KEEP="${LASCODIA_UI_KEEP:-5}"
BUILD_OUT="$REPO_ROOT/dist/lascodia-admin/browser"
RELEASES="$WEBROOT/releases"
CURRENT="$WEBROOT/current"

# API_BASE_URL is deliberately allowed to be the empty string: the UI then
# resolves the engine same-origin (Caddy proxies /api/* and /health*), which is
# the only shape a remote browser coming through the tunnel can use.  `:-` would
# treat an explicit "" as unset, so use ${VAR+set} semantics via a default.
API_BASE_URL="${API_BASE_URL-}"
ENVIRONMENT_LABEL="${ENVIRONMENT_LABEL:-production}"

log()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── helpers ──────────────────────────────────────────────────────────────────

# Resolve the release directory `current` points at (basename only), or "" when
# nothing is published yet.
current_release() {
  [ -L "$CURRENT" ] || { printf ''; return 0; }
  basename "$(readlink "$CURRENT")"
}

# Releases on disk, NEWEST FIRST.  Names start with a sortable UTC timestamp, so
# a reverse lexical sort is a reverse chronological sort.
list_releases() {
  [ -d "$RELEASES" ] || return 0
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null |
    xargs -0 -n1 basename 2>/dev/null | LC_ALL=C sort -r
}

# Swap `current` atomically: create the new symlink under a temp name, then
# rename(2) it over the old one. A concurrent request follows either the whole
# old release or the whole new one; there is no instant where `current` is
# missing.
#
# Done via node's fs.renameSync, NOT `mv -f`, and that distinction is the whole
# ballgame. `current` is a symlink TO A DIRECTORY, and BSD `mv` follows it: the
# first version of this script moved each new link INSIDE the old release
# (`releases/<old>/.current.72695`) instead of replacing it. Every publish
# appeared to succeed while the live site stayed pinned to the first release
# ever published. rename(2) never follows a symlink in the final path component,
# so it replaces the link itself. (GNU `mv -T` would also do it; macOS `mv` has
# no such flag.)
#
# The readlink assertion afterwards is deliberate belt-and-braces: a swap that
# silently does nothing is the single most dangerous failure this script can
# have, because everything downstream still reports success.
swap_current() {
  local release="$1"
  [ -d "$RELEASES/$release" ] || die "no such release: $release"
  [ -f "$RELEASES/$release/index.html" ] \
    || die "release $release has no index.html — refusing to point current at it"
  if [ -e "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
    die "$CURRENT exists and is not a symlink — refusing to touch it"
  fi

  WEBROOT="$WEBROOT" TARGET="releases/$release" node -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.env.WEBROOT, target = process.env.TARGET;
    const tmp = path.join(root, ".current.swap." + process.pid);
    try { fs.unlinkSync(tmp) } catch {}
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, path.join(root, "current"));
  ' || die "failed to swap the current symlink"

  local now
  now="$(basename "$(readlink "$CURRENT")")"
  [ "$now" = "$release" ] \
    || die "swap did not take: current -> $now (expected $release)"
}

# Read a key out of a release's own config.json on disk.
release_config_key() {
  node -e '
    const fs = require("fs");
    try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]] ?? "")) }
    catch {}
  ' "$RELEASES/$1/config.json" "$2"
}

# Read a single key out of the config.json the ORIGIN is actually serving.
# This is the load-bearing check: publishing to disk proves nothing about what
# Caddy hands a browser (wrong root, stale symlink, cached layer, typo in the
# Caddyfile — all of those look like a successful publish otherwise).
served_config_key() {
  local key="$1" body
  body="$(curl -fsS -m 10 -H 'Cache-Control: no-cache' "$ORIGIN/config.json" 2>/dev/null)" || return 1
  printf '%s' "$body" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const c=JSON.parse(s);process.stdout.write(String(c[process.argv[1]]??""))}
      catch{process.exit(1)}});' "$key"
}

# Prove the ORIGIN is serving the exact release we just activated.
#
# The identity checked here is the RELEASE ID, not the git SHA. Two publishes of
# the same commit are routine (rebuild after a config or flag change), and they
# share a buildSha — so a SHA check would pass against the release you were
# trying to move away from, i.e. it would report success for a rollback that
# never happened. The release id is unique per publish, so it cannot.
verify_live() {
  local expect_id="$1" got_id code

  code="$(curl -fsS -m 10 -o /dev/null -w '%{http_code}' "$ORIGIN/" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] || die "verify: $ORIGIN/ returned $code (expected 200)"

  got_id="$(served_config_key releaseId)" || die "verify: could not read $ORIGIN/config.json"
  [ "$got_id" = "$expect_id" ] \
    || die "verify: live releaseId is '${got_id:-<unset>}', expected '$expect_id' — the swap did not take effect"

  # A deep link must resolve to the SPA shell, not 404.  This catches a missing
  # try_files/SPA-fallback rule, which only shows up when an operator reloads on
  # a sub-route (i.e. always, eventually).
  code="$(curl -fsS -m 10 -o /dev/null -w '%{http_code}' "$ORIGIN/ea-instances" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] || die "verify: deep link /ea-instances returned $code — SPA fallback is not wired"

  # The engine must still be reachable through the same origin, or the console
  # renders a shell that can talk to nothing.
  code="$(curl -fsS -m 10 -o /dev/null -w '%{http_code}' "$ORIGIN/health" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] || warn "verify: $ORIGIN/health returned $code — engine proxy may be down (UI itself is live)"

  ok "verified live at $ORIGIN — release $got_id, SPA fallback OK"
}

# ── publish ──────────────────────────────────────────────────────────────────

cmd_publish() {
  local do_verify=1
  for a in "$@"; do
    case "$a" in
      --no-verify) do_verify=0 ;;
      *) die "unknown option: $a" ;;
    esac
  done

  cd "$REPO_ROOT"

  local sha dirty=""
  sha="$(git rev-parse --short HEAD)"
  # Record uncommitted state in the release identity rather than refusing it.
  # A release you cannot trace back to a commit is worse than one labelled
  # honestly as untraceable.
  git diff --quiet HEAD -- . || dirty="-dirty"
  local build_sha="${sha}${dirty}"
  local build_time stamp release
  build_time="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  stamp="$(date -u '+%Y%m%d-%H%M%S')"
  release="${stamp}-${sha}${dirty}"

  [ -n "$dirty" ] && warn "working tree is dirty — publishing as $release"

  log "building production bundle (this is the gate that catches budget/AOT errors)"
  npm run build -- --configuration production

  [ -f "$BUILD_OUT/index.html" ] || die "build produced no $BUILD_OUT/index.html"

  # Stamp the runtime config INTO the artifact.  Two things matter here:
  #   * apiBaseUrl must be same-origin ("") so a browser arriving through the
  #     tunnel resolves the engine via Caddy instead of localhost:5081, which it
  #     cannot reach;
  #   * buildSha/buildTime make the deploy observable — the footer version pill
  #     and `release.sh status` both read them, so "did my change go live?" is a
  #     question with an answer.
  # featureFlags are carried over verbatim from public/config.json so the
  # published bundle behaves like the source of truth in the repo.
  log "stamping config.json (apiBaseUrl='${API_BASE_URL}', buildSha=$build_sha)"
  API_BASE_URL="$API_BASE_URL" BUILD_SHA="$build_sha" BUILD_TIME="$build_time" \
  RELEASE_ID="$release" \
  ENVIRONMENT_LABEL="$ENVIRONMENT_LABEL" SRC_CONFIG="$REPO_ROOT/public/config.json" \
  OUT_CONFIG="$BUILD_OUT/config.json" node -e '
    const fs = require("fs");
    const src = JSON.parse(fs.readFileSync(process.env.SRC_CONFIG, "utf8"));
    const out = {
      apiBaseUrl: process.env.API_BASE_URL,
      buildSha: process.env.BUILD_SHA,
      buildTime: process.env.BUILD_TIME,
      releaseId: process.env.RELEASE_ID,
      environmentLabel: process.env.ENVIRONMENT_LABEL,
    };
    if (src.featureFlags) out.featureFlags = src.featureFlags;
    for (const k of Object.keys(src)) if (k.startsWith("sentry")) out[k] = src[k];
    fs.writeFileSync(process.env.OUT_CONFIG, JSON.stringify(out, null, 2) + "\n");
  '

  mkdir -p "$RELEASES"

  # Stage under a .partial name first.  If the copy dies halfway the directory
  # never carries a release name, so `list`/`rollback` can never select it.
  local staging="$RELEASES/.partial-$release"
  rm -rf "$staging"
  log "staging release $release"
  mkdir -p "$staging"
  rsync -a --delete "$BUILD_OUT/" "$staging/"
  chmod -R a+rX "$staging"
  mv "$staging" "$RELEASES/$release"

  local previous
  previous="$(current_release)"
  log "activating $release${previous:+ (previous: $previous)}"
  swap_current "$release"

  if [ "$do_verify" = "1" ]; then
    verify_live "$release"
  else
    warn "skipped live verification (--no-verify)"
  fi

  cmd_prune
  ok "published $release"
  [ -n "$previous" ] && printf '  rollback with: scripts/release.sh rollback %s\n' "$previous"
  return 0
}

# ── rollback ─────────────────────────────────────────────────────────────────

cmd_rollback() {
  local target="${1:-}" cur
  cur="$(current_release)"
  if [ -z "$target" ]; then
    # Previous = the newest release that is not the current one.
    target="$(list_releases | grep -v -x -F "$cur" | head -1 || true)"
    [ -n "$target" ] || die "no earlier release to roll back to"
  fi
  [ "$target" != "$cur" ] || die "$target is already live"
  log "rolling back $cur → $target"
  swap_current "$target"
  # Verify against the id baked into the release we just activated, read from
  # ITS OWN config.json rather than from the directory name — so the check is
  # about bytes actually being served, not about labels agreeing with labels.
  local expect
  expect="$(release_config_key "$target" releaseId)"
  if [ -n "$expect" ]; then
    verify_live "$expect"
  else
    warn "release $target predates release-id stamping — verifying reachability only"
    verify_live "$(served_config_key releaseId)"
  fi
  ok "rolled back to $target"
}

# ── list / status / prune ────────────────────────────────────────────────────

cmd_list() {
  local cur; cur="$(current_release)"
  [ -d "$RELEASES" ] || { echo "no releases yet ($RELEASES does not exist)"; return 0; }
  list_releases | while read -r r; do
    [ -n "$r" ] || continue
    if [ "$r" = "$cur" ]; then printf '  \033[1;32m* %s\033[0m  (live)\n' "$r"
    else printf '    %s\n' "$r"; fi
  done
}

cmd_status() {
  local cur head_sha served_sha served_time
  cur="$(current_release)"
  head_sha="$(cd "$REPO_ROOT" && git rev-parse --short HEAD)"

  printf 'publish root : %s\n' "$WEBROOT"
  printf 'current link : %s\n' "${cur:-<none>}"
  printf 'repo HEAD    : %s\n' "$head_sha"

  if served_sha="$(served_config_key buildSha)"; then
    served_time="$(served_config_key buildTime || true)"
    local served_id; served_id="$(served_config_key releaseId || true)"
    printf 'served by %s : buildSha %s (%s)\n' "$ORIGIN" "${served_sha:-<unset>}" "${served_time:-?}"
    printf '               release  %s\n' "${served_id:-<unset>}"
    # A served release that disagrees with the symlink means something other
    # than this script is answering on the origin.
    if [ -n "$served_id" ] && [ -n "$cur" ] && [ "$served_id" != "$cur" ]; then
      warn "origin serves release $served_id but the symlink points at $cur — something else is answering"
    fi
    case "$served_sha" in
      "$head_sha"|"$head_sha-dirty") ok "live bundle matches the checked-out commit" ;;
      "") warn "origin serves a config.json with no buildSha — is Caddy still proxying ng serve?" ;;
      *)  warn "live bundle ($served_sha) is NOT the checked-out commit ($head_sha) — publish to update" ;;
    esac
  else
    warn "could not read $ORIGIN/config.json — is Caddy running?"
  fi

  if pgrep -f 'ng serve' >/dev/null 2>&1; then
    warn "an 'ng serve' dev server is running — that is fine, it no longer serves $ORIGIN"
  fi
}

cmd_prune() {
  local cur n=0
  cur="$(current_release)"
  # Never prune the live release, whatever its age.
  list_releases | while read -r r; do
    [ -n "$r" ] || continue
    [ "$r" = "$cur" ] && continue
    n=$((n + 1))
    if [ "$n" -ge "$KEEP" ]; then
      rm -rf "$RELEASES/$r"
      log "pruned old release $r"
    fi
  done
  # Sweep abandoned staging dirs from an interrupted publish, plus any stray
  # swap symlinks (including ones the old `mv -f` bug nested inside a release).
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -exec rm -rf {} + 2>/dev/null || true
  # depth 3 = $WEBROOT/releases/<release>/.current.NNN — where the `mv -f` bug
  # deposited them; depth 1 covers a temp link left by an interrupted swap.
  find "$WEBROOT" -maxdepth 3 -type l -name '.current.*' -delete 2>/dev/null || true
}

# ── dispatch ─────────────────────────────────────────────────────────────────

case "${1:-publish}" in
  publish)  shift || true; cmd_publish "$@" ;;
  rollback) shift || true; cmd_rollback "$@" ;;
  list)     cmd_list ;;
  status)   cmd_status ;;
  prune)    cmd_prune ;;
  -h|--help|help)
    sed -n '/^# USAGE/,/^# ───/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command: $1 (publish|rollback|list|status|prune)" ;;
esac

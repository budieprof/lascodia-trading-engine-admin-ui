# Public tunnel for the admin UI

Runbook for exposing the admin UI + engine API to the public internet through
Cloudflare. Two distinct uses:

1. **The permanent deployment.** `app.codiapay.com` is a _named_ tunnel running
   as a LaunchDaemon, fronting the **compiled release** of the UI. This is how
   the live operator console is served. See [Persistent named
   tunnel](#persistent-named-tunnel) — it is already set up; nothing in the
   "Starting a session" section below needs doing for it.
2. **Ad-hoc quick tunnels.** Sharing a work-in-progress with someone off-net or
   testing from a phone. Ephemeral `*.trycloudflare.com` URL, and the one case
   where pointing the proxy at `ng serve` still makes sense.

> **Changed 2026-09-19.** This doc used to describe one setup where Caddy's
> catch-all proxied `ng serve` on `:4200` for _both_ uses. The permanent
> deployment no longer does: Caddy serves static files from a published release
> directory, so source edits no longer hot-reload the live console and the whole
> thing survives a reboot with no `npm start`. Deployment details live in
> [../CLAUDE.md](../CLAUDE.md#deployment) and `scripts/release.sh`; the
> `Caddyfile` is now tracked rather than gitignored.

## Why a reverse proxy at all

The admin UI talks to the engine through the `apiBaseUrl` in its runtime
`config.json` (`http://localhost:5081` in development). A naive tunnel that
exposes only the UI sends that bundle to a remote browser, where every API call
hits **the visitor's own** `localhost:5081` — which obviously doesn't reach the
operator's laptop. Either both ports get tunnelled (two URLs, manual UI
re-config), or they have to look like one origin.

This runbook chooses the second option: Caddy fronts both, the UI runs in
**same-origin** mode (`apiBaseUrl = ""`), and only one URL goes out via
Cloudflare. That is why every published release bakes `apiBaseUrl: ""` — it is
the only shape that works for a browser arriving through the tunnel.

## What's running

The permanent deployment — what `app.codiapay.com` actually serves today:

```
┌─────────────────────┐                                  ┌─────────────────┐
│   public internet   │ ─── https://app.codiapay.com ──▶ │   cloudflared   │
└─────────────────────┘                                  └────────┬────────┘
                                                                  │ localhost:8080
                                                         ┌────────▼────────┐
                                                         │      Caddy      │
                                                         └────────┬────────┘
                                     ┌────────────────────────────┼────────────────┐
                               /api/*│                    /health*│               /│ (catch-all)
                             localhost:5081             localhost:5081     static files
                             ┌───────▼───────┐          ┌────────▼──────┐  ┌───────▼─────────────┐
                             │  Engine API   │          │ Engine health │  │ /opt/homebrew/var/  │
                             │  (Docker)     │          │  probes       │  │ www/lascodia-admin/ │
                             └───────────────┘          └───────────────┘  │ current  (symlink)  │
                                                                           └─────────────────────┘
```

Three processes, and **none of them is a Node process**:

| Process              | Port | Role                                                       |
| -------------------- | ---- | ---------------------------------------------------------- |
| Docker `api-1`       | 5081 | Engine API (+ SignalR hub at `/api/hubs/trading`).         |
| `caddy`              | 8080 | Reverse proxy + static file server. Root LaunchDaemon.     |
| `cloudflared tunnel` | —    | Outbound connection to Cloudflare edge → public HTTPS URL. |

The UI itself is a directory of files on disk, published by
`scripts/release.sh`. For an **ad-hoc quick tunnel** against work in progress,
swap the catch-all for `reverse_proxy localhost:4200` and run `npm start` —
that variant is what the rest of this doc's session recipe describes.

## Prereqs

One-off install:

```bash
brew install caddy cloudflared
```

No Cloudflare account is needed for **quick tunnels** — each session gets an
ephemeral `https://<random-words>.trycloudflare.com`. For a stable URL on
your own domain, see [Persistent named tunnel](#persistent-named-tunnel)
below.

## Caddyfile

**The deployed config** is `/opt/homebrew/etc/Caddyfile`, with a tracked
reference copy of its `:8080` site at the project root ([../Caddyfile](../Caddyfile)).
It serves the compiled release and proxies `/api/*` + `/health*`; read it there
rather than reproducing it here, since a copy in a doc drifts. It is no longer
gitignored — it stopped being throwaway dev tooling the moment it became the
config serving the live console.

Two details worth knowing before editing it:

- **`/health*` needs its own block.** Without it the static catch-all answers
  `/health` with `index.html` and HTTP 200, so every EA reads a dead engine as
  healthy and the dead-man switch never fires.
- **Releases bake `apiBaseUrl: ""` into their own `config.json`,** so Caddy no
  longer serves an inline `/config.json` override. Feature flags come from
  `public/config.json` at publish time — change them there, then publish. (The
  old inline `respond` had to be hand-mirrored and silently went stale.)

For an **ad-hoc quick tunnel** against a work-in-progress instead, point the
catch-all at the dev server:

```caddyfile
handle {
    reverse_proxy localhost:4200 {
        # Angular's dev server checks the Host header against an allow-list;
        # rewriting to localhost keeps it happy without touching angular.json.
        header_up Host {upstream_hostport}
    }
}
```

That variant also needs the inline `/config.json` override the deployed config
dropped, since `ng serve` serves `public/config.json` with its
`http://localhost:5081` base URL, which a remote browser cannot reach.

## Starting a session

> For `app.codiapay.com` there is **no session to start** — cloudflared and
> Caddy are both `RunAtLoad` LaunchDaemons and the UI is static files on disk.
> To ship a UI change there, run `./scripts/release.sh publish`. The steps below
> are for an ad-hoc quick tunnel.

Three commands, three terminals (or background each one).

### 1. Make sure the engine + Angular are already running

```bash
# Engine in Docker
docker compose -f path/to/lascodia-trading-engine/docker-compose.yml up -d api

# Angular dev server (project root of admin UI) — quick-tunnel variant only
npm start
```

### 2. Start Caddy

```bash
caddy run --config Caddyfile
```

Smoke-test the local proxy before going public:

```bash
curl -s http://localhost:8080/config.json | head -1
# → {"apiBaseUrl":"","featureFlags":...}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/
# → 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/v1/lascodia-trading-engine/config
# → 401 (auth required — correct, proves the proxy reached the engine)
```

### 3. Start the tunnel

```bash
cloudflared tunnel --url http://localhost:8080
```

The first ~10 seconds of output ends with something like:

```
+--------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take a few      |
|  minutes to be reachable):                                               |
|  https://getting-calgary-costa-functions.trycloudflare.com               |
+--------------------------------------------------------------------------+
```

That URL is your public entry point. Open it on any device on the internet.

### Backgrounded variant

If you want to claim your terminal back:

```bash
nohup caddy run --config Caddyfile > /tmp/caddy.log 2>&1 &
nohup cloudflared tunnel --url http://localhost:8080 > /tmp/cloudflared.log 2>&1 &

# Recover the URL after launch:
grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/cloudflared.log | head -1
```

## Stopping

```bash
# By PID if you launched detached:
lsof -i :8080 -sTCP:LISTEN | awk 'NR>1 {print $2}' | xargs -r kill   # caddy
pkill -f 'cloudflared tunnel'                                         # cloudflared
```

Or just `Ctrl-C` in each foreground terminal. Nothing persists — no system
service is installed (we deliberately avoided `brew services start`), no
project files are modified, no cloudflare account state changes.

## Troubleshooting

**`HTTP 403` from `/` through the tunnel.** Angular's dev server is
rejecting the cloudflare host. The `header_up Host {upstream_hostport}`
line in the catch-all `handle` block fixes this — make sure it's present.

**`HTTP 502` from `/api/*`.** Engine isn't running. Check `docker compose ps
api` — the health check should say `(healthy)`. If it says `(starting)`
wait 30 s; if it's down, restart with `docker compose up -d api`.

**Port 8080 already in use.** Something else owns the port:
`lsof -i :8080 -sTCP:LISTEN`. Either kill it or pick a different port in
the `Caddyfile`'s `:8080 { … }` line and pass the matching `--url
http://localhost:NEWPORT` to cloudflared.

**Feature flags differ between tunnel and direct dev.** The inline JSON in
the Caddyfile shadows `public/config.json` for tunnel sessions. When you
change a flag in the project, mirror it in the Caddyfile or the tunnelled UI
will diverge.

**HMR WebSocket disconnects every few seconds in the browser.** Cloudflare
Quick Tunnels generally hold WebSocket connections fine, but the edge can
recycle them. This is cosmetic — the browser auto-reconnects. If it's
disruptive, switch to a named tunnel (more stable transport).

**Tunnel URL changes every restart.** That's how quick tunnels work — each
`cloudflared tunnel --url …` session gets a fresh subdomain. If you need a
stable URL, see below.

## Persistent named tunnel

A named tunnel keeps the same public URL across restarts, maps to your own
domain, and unlocks Cloudflare Access for auth gating.

### One-time setup

1. **Move the domain's DNS to Cloudflare** (registrar stays put, only
   nameservers change). In the Cloudflare dashboard: **Domains → Add a
   domain → Connect a domain → enter the apex**. Cloudflare scans existing
   DNS; review and accept. Then change the nameservers at your registrar
   to the two Cloudflare nameservers shown. Propagation is usually under
   an hour. Verify with `dig +short NS yourdomain.com` — the output should
   be `*.ns.cloudflare.com`.

   **Important during the import**: Cloudflare defaults all `A` records to
   Proxied (orange cloud). The proxy is HTTP/HTTPS only — anything mail
   (`mail`, `webmail` if IMAP), SQL, or other non-HTTP services must be
   flipped to **DNS only** (grey cloud) before activation or you'll break
   non-web origins the moment nameservers flip.

2. **Authorise cloudflared on the laptop**:

   ```bash
   cloudflared tunnel login    # opens browser — pick the zone, click Authorize
   ```

   This writes `~/.cloudflared/cert.pem`.

3. **Create the tunnel + DNS record**:

   ```bash
   cloudflared tunnel create lascodia
   cloudflared tunnel route dns lascodia app.codiapay.com
   ```

   The create step writes a per-tunnel credentials JSON at
   `~/.cloudflared/<tunnel-uuid>.json`. The route step adds a proxied
   CNAME in your Cloudflare zone pointing the subdomain at the tunnel.

4. **Drop `~/.cloudflared/config.yml`** with the tunnel name + credentials
   path + ingress rules:

   ```yaml
   tunnel: lascodia
   credentials-file: /Users/<you>/.cloudflared/<tunnel-uuid>.json
   ingress:
     - hostname: app.codiapay.com
       service: http://localhost:8080
     - service: http_status:404
   ```

   The catch-all `http_status:404` is required — anything that doesn't
   match the hostname above gets a polite 404 instead of leaking onto
   the laptop.

### Running

Same Caddyfile, same `:8080`. The named tunnel replaces the ephemeral one:

```bash
# Make sure no quick tunnel is still running:
pkill -f 'cloudflared tunnel --url'

# Run the named tunnel:
cloudflared tunnel run lascodia
```

Or detached:

```bash
nohup cloudflared tunnel run lascodia > /tmp/cloudflared.log 2>&1 &
```

### Auto-start on boot — the macOS gotcha

`sudo cloudflared service install` writes a LaunchDaemon plist at
`/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`, but on macOS at
the version we use the plist it generates invokes `cloudflared` with **no
arguments** and writes a stub `/usr/local/etc/cloudflared/config.yml` that
only sets `logDirectory`. The daemon starts, prints `use 'cloudflared
tunnel run' to start tunnel lascodia` to the log, exits, gets restarted by
KeepAlive, exits again. Cloudflare edge sees no connections and returns
error 1033 / HTTP 530.

The repair is two-step. **Step 1** — copy the actual config + credentials

- cert.pem from the user's home into the system path the root daemon will
  read:

```bash
sudo cp ~/.cloudflared/cert.pem /usr/local/etc/cloudflared/cert.pem
sudo cp ~/.cloudflared/<tunnel-uuid>.json /usr/local/etc/cloudflared/
sudo tee /usr/local/etc/cloudflared/config.yml >/dev/null <<'EOF'
tunnel: lascodia
credentials-file: /usr/local/etc/cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: app.<your-domain>
    service: http://localhost:8080
  - service: http_status:404
EOF
```

**Step 2** — rewrite the plist with the correct `ProgramArguments` so
launchd actually invokes `tunnel run` against the config:

```bash
sudo tee /Library/LaunchDaemons/com.cloudflare.cloudflared.plist >/dev/null <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cloudflare.cloudflared</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/cloudflared</string>
        <string>--no-autoupdate</string>
        <string>--config</string>
        <string>/usr/local/etc/cloudflared/config.yml</string>
        <string>tunnel</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>/Library/Logs/com.cloudflare.cloudflared.out.log</string>
    <key>StandardErrorPath</key><string>/Library/Logs/com.cloudflare.cloudflared.err.log</string>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>5</integer>
</dict>
</plist>
EOF
sudo launchctl bootout system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist 2>/dev/null
sudo launchctl bootstrap system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
```

Verify the daemon is up with the right arguments:

```bash
ps -axww -o pid,user,command | grep '[c]loudflared.*tunnel run'
launchctl print system/com.cloudflare.cloudflared | grep state
```

Look for `state = running` and the process listing should show the full
`--no-autoupdate --config /usr/local/etc/cloudflared/config.yml tunnel
run` argv. Then the tunnel survives reboot — cloudflared starts at boot,
before login, before Caddy.

### Caddy auto-start

The deployed `Caddyfile` lives in `/opt/homebrew/etc/Caddyfile`:

```bash
cp Caddyfile /opt/homebrew/etc/Caddyfile   # then re-append the LAN :443 block
sudo brew services start caddy
```

**It must run as root**, i.e. `sudo brew services start caddy` (a
LaunchDaemon in `/Library/LaunchDaemons/`), not the plain user LaunchAgent
`brew services start` installs. macOS refuses to let a non-root process bind
ports below 1024, so the user-level service cannot serve the `:443` LAN
endpoint — it fails to bind and silently keeps serving only `:8080`. Verify
with `lsof -nP -iTCP:443 -sTCP:LISTEN`.

Reload after an edit without dropping connections:

```bash
caddy reload --config /opt/homebrew/etc/Caddyfile
```

### Nothing else needs starting

The UI is static files under `/opt/homebrew/var/www/lascodia-admin/current`, so
after a reboot cloudflared and Caddy come up on their own (both `RunAtLoad`)
and the console is live with no manual step.

This is the part that changed on 2026-09-19. Previously this section read
"`ng serve` is NOT in this picture — after a reboot, run `npm start` by hand",
which meant the public console was down from reboot until someone noticed, and
that whatever happened to be checked out at that moment went live. Publishing a
release is now the only way anything reaches it.

Verify end-to-end (browser is more reliable than `curl` here — macOS's
resolver holds a negative NXDOMAIN cache for the subdomain for ~5 min
after it's created, which only browsers smart-bypass):

```bash
dig +short app.codiapay.com @1.1.1.1     # cloudflare anycast IPs
```

Then open `https://app.codiapay.com/` in a browser. Cloudflare provisions
the cert automatically; the UI loads from Caddy's static release directory,
API calls flow via Caddy → engine, all on the same origin.

`./scripts/release.sh status` answers "is the live console the commit I think
it is?" without opening a browser at all.

### Auth gating with Cloudflare Access (recommended)

The named tunnel is **publicly reachable** until you put auth in front of
it. In the Cloudflare dashboard: **Zero Trust → Access → Applications →
Add an application → Self-hosted**. Point it at `app.codiapay.com`, pick
auth methods (Google / GitHub / email OTP), and add an email allow-list.
Now anyone reaching `app.codiapay.com` must authenticate _before_ the
request reaches your laptop. Free for up to 50 users.

## Security

The tunnel is public unauthenticated transport. Specifically:

- **Anyone with the URL hits the engine.** The engine's bearer-token auth
  rejects unauthenticated calls (you'll see `401` on any direct probe), but
  the UI's session is whatever browser cookie the visitor brings — if
  someone visits the tunnel URL and finds you already logged in on that
  browser session, they inherit it. Don't share the URL casually.
- **Never run a public tunnel against the engine in `Live` mode.** Anyone
  who reaches an authenticated session can place real orders. Paper mode
  only for tunnel sessions.
- **Kill the tunnel when you're done.** Quick tunnels are session-scoped;
  the URL stops resolving when `cloudflared` exits. Named tunnels with DNS
  persist until you delete them.
- **Add Cloudflare Access** (or some equivalent auth gate) before exposing
  anything beyond a temporary share.

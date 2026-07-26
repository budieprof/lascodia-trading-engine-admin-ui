---
name: browser-verify
description: >
  Verify an admin-UI change in a real browser — drive the running Angular app
  with Playwright + Chromium, authenticate, navigate to the affected route(s),
  screenshot, and report console/network errors. Use whenever you've made a UI
  change and want to SEE it render (not just build it), when asked to "check the
  admin UI", "run/screenshot the app in a browser", "verify it renders", or to
  confirm a page loads without errors. This is the Lascodia admin-UI (Angular 20,
  standalone components, `ng serve` on :4200, engine API on :5081).
---

# Verify admin-UI changes in a browser

The app is a browser-driven Angular SPA. "Running it" means loading it in
Chromium and looking at the rendered page — a green `ng build` only proves it
typechecks. Drive it, screenshot it, **look at the screenshot.**

## Preconditions (usually already true)

- **Dev server:** the UI is served at `http://localhost:4200`. Check:
  `curl -s -o /dev/null -w "%{http_code}" http://localhost:4200/` → `200`.
  If it's not running, start it: `npm start` (aka `ng serve`) from the repo root,
  in the background, and wait for `200`. Never `make compile`/kill live terminals.
- **Engine API:** `http://localhost:5081` (Docker). `curl -s localhost:5081/health`
  should answer (`Healthy`/`Degraded` both fine).
- **Playwright + Chromium:** already installed in `node_modules` (browser cached
  under `~/Library/Caches/ms-playwright`). If `require('playwright')` fails, run
  `npx playwright install chromium` once.

## Auth: inject a dev token (no login form needed)

The app keeps its JWT in `sessionStorage['lascodia.auth.token']`. `hasRole`
treats an empty roles claim as **full access**, so a hand-minted superadmin dev
token authenticates every route. Mint one (HS256, dev secret):

```bash
python3 - > /tmp/lasc_ui_jwt.txt <<'PY'
import hmac,hashlib,base64,json,calendar,datetime
b64=lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
secret="docker-dev-lascodia-jwt-secret-key-change-in-production-min-32!"
now=int(calendar.timegm(datetime.datetime.utcnow().timetuple()))
pl={"sub":"dev-superadmin","is_superadmin":"true",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier":"1",
    "iss":"lascodia-trading-engine","aud":"lascodia-trading-engine-api",
    "iat":now,"nbf":now,"exp":now+8*3600}
seg=b64(json.dumps({"alg":"HS256","typ":"JWT"}).encode())+"."+b64(json.dumps(pl).encode())
print(seg+"."+b64(hmac.new(secret.encode(),seg.encode(),hashlib.sha256).digest()))
PY
```

The driver injects it into sessionStorage after loading the origin, then
navigates — so route guards pass.

## Drive it

`drive.js` (next to this file) launches Chromium, authenticates, visits each
route you pass, screenshots it, and prints a JSON report with the final URL,
page title, a text excerpt, and any `>=400` responses / console errors. Run it
**from the repo root** so `require('playwright')` resolves:

```bash
LASC_JWT="$(cat /tmp/lasc_ui_jwt.txt)" \
OUT=/tmp \
node .claude/skills/browser-verify/drive.js /conversations /dashboard /watchlist
```

Then **Read the PNGs** it wrote (`/tmp/ui_<route>.png`) — a blank/blocked frame
is a failure. Pick routes that exercise your change (e.g. `/conversations` for
the analysis chat + rec charts, `/watchlist` for tiles, `/dashboard` for the shell).

## Reading the result

- **Screenshot renders the change** → done. Report what you saw.
- **Console/network errors** → investigate the offending endpoint in the engine
  logs (`docker logs lascodia-trading-engine-api-1 --since 5m`).
- **Known false positives under the synthetic dev token** (ignore unless they
  reproduce under a real login):
  - `/admin/notifications/feed` → **500** (`CurrentUserService.GetUser` does
    `.First()` on a claim the hand-minted token lacks; real login tokens carry it).
  - SignalR "Failed to complete negotiation / Failed to start the connection" —
    the realtime hub can't authenticate the injected token from the headless
    context. Page rendering is unaffected.

If the driver needed new packages, a browser install, or config you had to add,
update this skill so the next run just works.

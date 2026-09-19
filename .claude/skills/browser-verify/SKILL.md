---
name: browser-verify
description: >
  Verify an admin-UI change in a real browser — drive the running Angular app
  with Playwright + Chromium, authenticate, navigate to the affected route(s),
  screenshot, and report console/network errors. Use whenever you've made a UI
  change and want to SEE it render (not just build it), when asked to "check the
  admin UI", "run/screenshot the app in a browser", "verify it renders", or to
  confirm a page loads without errors. This is the Lascodia admin-UI (Angular 20,
  standalone components, engine API on :5081). Two origins: the published release
  on :8080 (what operators see) and the `ng serve` dev server on :4200 (work in
  progress) — pick deliberately.
---

# Verify admin-UI changes in a browser

The app is a browser-driven Angular SPA. "Running it" means loading it in
Chromium and looking at the rendered page — a green `ng build` only proves it
typechecks. Drive it, screenshot it, **look at the screenshot.**

## Preconditions (usually already true)

- **Pick the right origin.** There are two, and they are different builds:
  - `http://localhost:8080` — the **published release** (static files via Caddy).
    Always up; this is what operators actually see. Use it to verify a deploy.
  - `http://localhost:4200` — the **dev server**, only up while someone is running
    `npm start`. Use it to verify work in progress.

  Check with `curl -s -o /dev/null -w "%{http_code}" <origin>/` → `200`. If you want
  :4200 and it's down, start `npm start` from the repo root in the background and wait
  for `200`. Never kill live terminals. Since 2026-09-19 source edits do **not** reach
  :8080 — publish with `./scripts/release.sh publish` first (see
  [CLAUDE.md](../../../CLAUDE.md#deployment)).

- **Engine API:** `http://localhost:5081` (Docker). `curl -s localhost:5081/health`
  should answer (`Healthy`/`Degraded` both fine).
- **Playwright + Chromium:** already installed in `node_modules` (browser cached
  under `~/Library/Caches/ms-playwright`). If `require('playwright')` fails, run
  `npx playwright install chromium` once.

## Auth: use the login form's Developer tab

> **The token-minting path below is BROKEN — don't use it.** The hardcoded HS256
> dev secret has drifted from the running engine, so every request comes back 401
> and the app bounces straight to `/login`. That failure reads as "the whole page
> is broken" rather than "auth failed", which is exactly how it wastes an hour.
> `drive.js` still implements it and still takes `LASC_JWT`; treat the file as
> needing the same fix.

The login form's **Developer** tab is passwordless — `onDevLogin()` posts a fixed
identity and the engine returns a real token, so it is valid by construction:

```js
await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
await page.getByRole('tab', { name: /Developer/i }).click();
await page.getByRole('button', { name: /Sign In/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
```

A `401` on `/auth/whoami` _before_ sign-in is the normal cold-session probe, not a
failure. Don't try to read the engine's real JWT secret out of the container env —
the permission classifier blocks it, correctly.

<details>
<summary>The old mint-a-token recipe (kept for context — does not authenticate)</summary>

The app keeps its JWT in `sessionStorage['lascodia.auth.token']`, and `hasRole`
treats an empty roles claim as full access, so this worked until the secret drifted:

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

</details>

## Drive it

`drive.js` (next to this file) launches Chromium, authenticates, visits each
route you pass, screenshots it, and prints a JSON report with the final URL,
page title, a text excerpt, and any `>=400` responses / console errors. Run it
**from the repo root** so `require('playwright')` resolves:

```bash
BASE=http://localhost:8080 \
LASC_JWT="$(cat /tmp/lasc_ui_jwt.txt)" \
OUT=/tmp \
node .claude/skills/browser-verify/drive.js /conversations /dashboard /watchlist
```

`BASE` defaults to `http://localhost:4200` (the dev server) — pass
`http://localhost:8080` to drive the published release instead. And because the
`LASC_JWT` path no longer authenticates, replace the driver's token injection
with the Developer-tab click sequence above before trusting any run.

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

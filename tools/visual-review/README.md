# Visual review crawl

Playwright scripts used for the full-UI reviews (2026-09-06, 2026-10-19). They screenshot every
route (full page, with tab clicks), click through every safe button with engine writes blocked,
and open the known-safe dialogs, recording API failures, console errors and clipped elements per
page.

| Script          | What it does                                                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crawl.js`      | Every route in `URLS`: full-page screenshot, then each tab. Bad tokens (NaN, undefined, `[object Object]` …), API 4xx/5xx, console errors, horizontal overflow → `crawl.<TAG>.json`. `THEME=dark\|light`, `WIDTH`, `TABS=0` to skip tabs.                 |
| `interact.js`   | Every distinct, safe-labelled button in each page body is clicked. Records whether it opened a dialog/menu (and whether that is clipped or ignores Escape), navigated, **would have written** to the engine, or changed nothing at all → `interact.json`. |
| `modals.js`     | A fixed list of known-safe dialog triggers, with the dialog's offset from centre.                                                                                                                                                                         |
| `login-shot.js` | The login page with no session, both themes, desktop + phone.                                                                                                                                                                                             |
| `serve-dist.js` | Serves a production build on :4300 with the Caddy routing, so a fix can be crawled before it is published.                                                                                                                                                |

```bash
# from the repo root, engine on :5081. BASE defaults to the live release on :8080 —
# point it at serve-dist.js (BASE=http://localhost:4300) to check an unpublished build.
export NODE_PATH="$PWD/node_modules"
cd tools/visual-review

# JWT must carry the five identity claims (passportId, firstName, lastName,
# email, mobileNo), is_superadmin, and role ["Admin","Operator"] for the
# role-gated routes. Mint one with the engine's JwtSettings__SecretKey.
JWT=$(cat jwt.txt) OUT=shots URLS=urls.txt PERMS_FILE=perms.json TAG=desk node crawl.js
JWT=$(cat jwt.txt) OUT=shots URLS=urls.txt PERMS_FILE=perms.json node interact.js
JWT=$(cat jwt.txt) OUT=shots PERMS_FILE=perms.json node modals.js
OUT=shots node login-shot.js

# Unpublished build:
npx ng build --configuration production && PORT=4300 node serve-dist.js &
BASE=http://localhost:4300 JWT=... OUT=... URLS=... node crawl.js
```

On this laptop run them one at a time through `/tmp/lascodia-heavy.sh` — each one is a
Chromium, and they share 16 GB with the Docker VM.

`PERMS_FILE` is the `data.permissions` array from `GET /admin/auth/me` (40 entries
for the superadmin). The scripts need it: permission-gated routes redirect to the
dashboard before that call answers, which shows up as an empty page in the crawl
and as a selector timeout in `modals.js`.

The JWT also needs an `adminUserId` claim (the `AdminUser.Id`, `1` for `superadmin`)
on top of the claims below — without it `/admin/auth/me` answers
`"Not an admin-user session."` and no permissions come back at all. (The login form's
Developer tab mints a token with NO role claims, so it cannot reach the role-gated routes.)

`urls.txt` is the full route list including detail routes with representative ids
(strategies/1213, backtests/4800, positions/6547, ea-instances/66 …); refresh the ids
when those records are gone. `/brokers/:id` takes a **slug**, not a number —
`/brokers/exness`, not `/brokers/1`, which renders "Broker not found".

Keep it one route per line and diff it against the router before trusting a run:
the 2026-09-06 pass silently skipped `/worker-health` for a whole review because
its line had been joined to the next one, and by 2026-10-19 eleven routes added since
(chart-analysis, patient-trader, trade-recommendations, pine-screener …) were missing.
To regenerate the route list, compose each `path:` in `app.routes.ts` with the `path:`
values of the feature `*.routes.ts` it lazily loads, then re-add the ids for the `:id`
routes; diff the sidebar's `route:` values against it too.

## Safety — these run against the live console

**Every script** (`crawl.js`, `interact.js`, `modals.js`) aborts every non-GET engine request at the network layer
unless its path ends in `/list`, `/paged`, `/query` or `/summary` (the engine's
read-by-POST convention) or it is the SignalR negotiate call; hub invocations are
subscription-only. `interact.js` additionally never clicks a button whose label names an
action (save, delete, flatten, launch, …), and `crawl.js`'s tab pass skips any non-`role=tab`
element with an action-like label. Keep both layers: labels drift and icon buttons have none,
and the network block is what makes a mis-aimed click harmless. On 2026-10-19, before
`crawl.js` had the block, its loose tab selector (`.tabs button`) clicked /alerts' "Test all
delivering" and "Send test" and two real Telegram test messages went out.

`modals.js` only clicks exact, known-safe button labels. Do not switch it to regex
matching — an earlier version clicked "Launch instance" on an EA detail page.

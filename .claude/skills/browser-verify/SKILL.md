---
name: browser-verify
description: >
  Verify an admin-UI change in a real browser — drive the running Angular app
  with Playwright + Chromium, authenticate, navigate to the affected route(s),
  screenshot, and report console/network errors. Use whenever you've made a UI
  change and want to SEE it render (not just build it), when asked to "check the
  admin UI", "run/screenshot the app in a browser", "verify it renders", or to
  confirm a page loads without errors. Also covers the harder cases: proving a
  control actually painted, sweeping many controls at once, reading the bytes the
  app really sends, and exercising screen sharing. This is the Lascodia admin-UI
  (Angular 20, standalone components, engine API on :5081). Two origins: the
  published release on :8080 (what operators see) and the `ng serve` dev server
  on :4200 (work in progress) — pick deliberately.
---

# Verify admin-UI changes in a browser

A green `ng build` only proves it typechecks. Drive it, screenshot it, **look at the
screenshot.** Everything below is written down because it cost real time to work out.

## Preconditions

- **Pick the right origin.**
  - `http://localhost:8080` — the **published release** (static files via Caddy). Always up;
    what operators actually see. Source edits do **not** reach it — publish first with
    `./scripts/release.sh publish`.
  - `http://localhost:4200` — the **dev server**, only while someone runs `npm start`.

  Check with `curl -s -o /dev/null -w "%{http_code}" <origin>/` → `200`.

- **Engine API:** `http://localhost:5081/health` should answer (`Healthy`/`Degraded` both fine).
- **Playwright + Chromium:** already in `node_modules`. Run scripts **from the repo root** so
  `require('playwright')` resolves. A script kept outside the repo needs
  `NODE_PATH="$PWD/node_modules"`.

## Auth: the login form's Developer tab

`drive.js` and `verify-lib.js` do this for you. Never hand-mint a JWT — the hardcoded dev
secret has drifted from the running engine, so every request 401s and the app bounces to
`/login`, which reads as "the whole page is broken" rather than "auth failed".

```js
await page.getByRole('tab', { name: /Developer/i }).click();
await page.getByRole('button', { name: /Sign In/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
```

## 1. Route smoke test — `drive.js`

```bash
OUT=/tmp node .claude/skills/browser-verify/drive.js /conversations /dashboard /watchlist
```

Then **Read the PNGs** it writes. A blank frame is a failure. `BASE=http://localhost:4200`
drives the dev server instead.

## 2. Did it actually PAINT? — `paintHash`

The failure that matters for charts is a control that adds its object, logs nothing, and
draws nothing. Unit tests and typechecks both pass.

Markets are closed at weekends, so the chart canvas is **static between actions** — which is
what makes a before/after pixel hash meaningful rather than noise:

```js
const { paintHash } = require('./.claude/skills/browser-verify/verify-lib');
const area = page.locator('.chart-shell, .panes, .chart-host').first();
const before = await paintHash(area);
await doTheThing();
const after = await paintHash(area); // different => something painted
```

**A changed hash proves something changed, not that the RIGHT thing did.** The anchored
volume profile briefly passed this because its anchor line moved pixels while the histogram
was still missing. When a component must render specific content, screenshot it and look.

## 3. Read the bytes the app really sends — `capturePosted`

Settles payload questions without reasoning about the code. This is how "is the assistant
panel in its own screenshot?" was answered — decode the JPEG and open it:

```js
const posted = capturePosted(page, '/follow-up');
// … drive the UI …
fs.writeFileSync('/tmp/sent.jpg', Buffer.from(posted[0].screenshot, 'base64'));
```

## 4. Sweeping many controls

For 18 chart styles / 71 indicators / 95 drawing tools, write one phased script with a
`record(name, ok, detail)` that prints `PASS`/`FAIL` per item and a tally at the end, then
re-run only the failures. Keep phases separate (`PHASE=styles|indicators|tools|ui`) — a
single run of everything is too long to read.

**Clean up after a sweep.** Drawings persist server-side: a tools sweep left 94 on EURUSD/60.
Clear them with the rail's danger button and confirm the clear survived a reload.

## 5. Assistant vision

Two sources, and the default is the easy one.

```js
await enableVision(page); // 'page' — DOM render, works HEADLESS, no prompt, no banner
await enableVision(page, 'screen'); // getDisplayMedia — headed only, see below
```

**Page mode** re-renders the live DOM (`modern-screenshot`) and never touches
`getDisplayMedia`, so there is no permission prompt and no browser sharing bar. It works in
headless Chromium. To prove a change did not silently fall back to the screen API, install a
tripwire before navigating:

```js
await page.addInitScript(() => {
  window.__gdmCalls = 0;
  const md = navigator.mediaDevices;
  const o = md?.getDisplayMedia?.bind(md);
  if (md) md.getDisplayMedia = (...a) => (window.__gdmCalls++, o(...a));
});
// …then: expect 0 after enabling page vision
```

**Screen mode** returns **`NotSupportedError` in headless Chromium under every flag
combination**, so it can only be exercised headed:

```js
const browser = await launch(chromium, { screen: true }); // headless:false + auto-accept
```

It also needs `display-capture=(self)` in the `Permissions-Policy` header (both Caddyfiles).
Without it the browser refuses before prompting and the toggle just fails to turn on — and
the console error blames _camera_, which is a red herring.

Neither the picker nor the "Sharing this tab" bar can be suppressed by the page: the picker
is mandated by the `getDisplayMedia` spec (the Chrome `*CaptureAllowedByOrigins` policies
only _permit_ capture, they do not bypass it) and the bar has no flag at all. That is why
page mode exists — do not go looking for a way to turn them off again.

## Traps that have cost time here

| Trap                                | What happens                                                                                                          | Do this                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **A stale tab**                     | The console is an SPA: a tab open since before a publish keeps its old JS and reproduces a bug that is already fixed. | Check the footer pill / `servedRelease(page)` **first** when a deployed fix is "not working". |
| `hasText: /^Label$/`                | Never matches — template interpolation leaves whitespace in `textContent`.                                            | `filter({ hasText: /^\s*4h\s*$/ })`, or `:has-text("…")`.                                     |
| Blind menu clicks                   | Menus toggle; a loop that clicks to open closes it every other pass.                                                  | `ensureOpen(page, button, panel)`.                                                            |
| Too few clicks                      | Multi-point tools need 6–7 anchors; a 5-click sweep made 8 working tools look broken.                                 | Click to the deepest tool's point count.                                                      |
| Reading the last `.msg`             | The last bubble is often a command card, not prose.                                                                   | Assert on the specific element, not "the last one".                                           |
| Asking the model instead of looking | It will describe what it expects.                                                                                     | Screenshot, decode, open the file.                                                            |
| `.assistant-fab`                    | Matches nothing — the class is `.fab`. Hide lists using it silently kept the Ask button in every captured frame.      | Grep the template for the real class before trusting a selector.                              |

## Reading the result

- **Screenshot shows the change** → done. Report what you saw.
- **Console/network errors** → investigate in the engine logs
  (`docker logs lascodia-trading-engine-api-1 --since 5m`).
- **Known-benign only:** a `401` on `/auth/whoami` before sign-in (cold-session probe), and
  `Permissions policy violation: camera is not allowed` while screen sharing (the capture
  still works). `collectErrors()` filters both. Treat anything else as real.

Driving the assistant end to end costs a real LLM call (up to ~180 s) — worth it for a
vision or page-command change, not for a layout tweak.

If a run needed new packages, a browser install, or config you had to add, update this skill
so the next one just works.

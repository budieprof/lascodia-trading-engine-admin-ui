# Lascodia Admin UI — Development Guide

## What this is

The operator console for the Lascodia Trading Engine. Angular 20 (standalone components,
signals, `@ngrx/signals` stores), Tailwind v4 + SCSS tokens, ag-grid + echarts, ~466 TS files
across 65 feature folders under `src/app/features/`.

It is a **live trading console**, not an internal dashboard: it places orders, trips kill
switches, flattens positions and edits engine config against real money. Treat a broken page
here the way you'd treat a broken page in the engine.

Backend: `../lascodia-trading-engine` (.NET 10, Clean Architecture + CQRS). Engine schema
changes can break this UI silently — see **Talking to the engine** below.

## Deployment — read this before "just refreshing the page"

**The live console is a compiled release served off disk. It is NOT `ng serve`.**

Editing source changes nothing that an operator sees until you publish. That decoupling is the
whole point, and it is new as of **2026-09-19** — before that Caddy proxied the dev server, so
every save hot-reloaded the console someone was trading from.

```bash
./scripts/release.sh publish      # build → stamp → stage → atomic swap → verify
./scripts/release.sh status       # what is live vs what is checked out
./scripts/release.sh list         # releases on disk, live one marked
./scripts/release.sh rollback     # previous release (or name one explicitly)
```

`npm run release`, `release:status`, `release:list`, `release:rollback` are the same thing.

### Topology

```
public internet
  └─ https://app.codiapay.com
       └─ cloudflared  (LaunchDaemon, RunAtLoad)
            └─ Caddy :8080   /opt/homebrew/etc/Caddyfile   (root LaunchDaemon, RunAtLoad)
                 ├─ /api/*    → engine :5081   (also the SignalR hub /api/hubs/trading)
                 ├─ /health*  → engine :5081
                 └─ /         → static files from
                                /opt/homebrew/var/www/lascodia-admin/current
```

```
/opt/homebrew/var/www/lascodia-admin/
  releases/20260919-114149-092a9ca/   ← one per publish, never mutated
  current -> releases/20260919-114149-092a9ca
```

`publish` swaps `current` with `rename(2)`, so a request sees either the whole old release or
the whole new one, and going live needs **no Caddy reload**. Rollback is the same swap in
reverse; the last 5 releases stay on disk.

No Node process is in the serving path, so the console survives a reboot on its own. Previously
it hung off one hand-started `npm start` — orphaned since 9 Sep 2026 and gone after any reboot.

`Caddyfile` in the repo root is the **reference copy** of the `:8080` site. The file Caddy runs
is `/opt/homebrew/etc/Caddyfile`, which also carries an `app.codiapay.com:443` LAN fast path used
only by EA instances on other machines. Keep them in sync by hand; `caddy reload --config
/opt/homebrew/etc/Caddyfile` applies changes with no downtime.

### Invariants

These are not preferences; violating them breaks something real.

- **`ng build --configuration production` is the deploy gate.** It is the only check that catches
  bundle budgets and prod-only AOT errors — `ng serve`, `npm test` and `test:components` all pass
  while it is red, which is how it stayed red for three days in Sep 2026. `release.sh publish`
  runs it first and aborts on failure. Never publish around it.
- **Verify a deploy by an identity unique to the DEPLOY, not the commit.** Each release stamps a
  unique `releaseId` into its own `config.json`; after the swap the script re-reads `config.json`
  _over HTTP_ and refuses to report success unless the origin serves that exact release. An
  earlier version compared the git SHA — two publishes of one commit share a SHA, so it passed for
  exactly the three deploys that never went live.
- **Never swap a symlink-to-a-directory with `mv -f` on macOS.** BSD `mv` follows it and moves the
  new link _inside_ the old target (`releases/<old>/.current.NNN`). Use `rename(2)`
  (node `fs.renameSync`); it never follows the final path component. macOS `mv` has no GNU `-T`.
- **`/health*` must keep its own Caddy block.** With a static SPA catch-all, losing it means
  `try_files` answers `/health` with `index.html` and HTTP 200 — so every EA reads a dead engine
  as healthy and the dead-man switch never fires. That is strictly worse than the 404s this block
  was originally added to fix.
- **Releases bake `apiBaseUrl: ""`** (same-origin). A browser arriving through the tunnel cannot
  reach `localhost:5081`. Override per publish with `API_BASE_URL=... npm run release`.
- **A green build proves nothing about whether a page renders.** Drive it in a browser
  (see **Verifying in a browser**).

### Deliberately not done

CSP is **not** copied from `docker/nginx.conf` into the Caddy config. That container has never
served this app in production, so the policy is unproven, and one missed directive fails closed on
a single page — silently, and only for whoever opens it. Needs a report-only pass first.

The `Dockerfile` + `docker/nginx.conf` path still works and is kept current, but it is not how
this deployment runs.

## Development

```bash
npm start        # ng serve on :4200 — yours to break, reaches nothing live
npm run build    # production build → dist/lascodia-admin/browser/
npm test         # vitest, one-shot
npm run lint     # eslint
```

`ng serve` reads `public/config.json`, which points at `http://localhost:5081` for local dev.
That file is the source of truth for **feature flags**; `release.sh` copies them into each
release verbatim, so a flag change ships on the next publish.

## Runtime configuration

The bundle is environment-agnostic. At boot the app fetches `config.json` _before_ bootstrapping
and provides it via the `RUNTIME_CONFIG` injection token
([src/app/core/config/runtime-config.ts](src/app/core/config/runtime-config.ts)).

`loadRuntimeConfig()` copies only **known keys** — a new config field is invisible to the app until
it is added both to the `RuntimeConfig` interface and to that copy. It falls back to
`environment.apiBaseUrl` on any fetch/parse failure, so a malformed `config.json` degrades to
localhost rather than a blank page.

## Talking to the engine

- Base: `/api/v1/lascodia-trading-engine/...` (same-origin in a release; `localhost:5081` in dev).
- Responses are wrapped in the engine's `ResponseData<T>` envelope — unwrapping lives in
  `src/app/core/api/`. Don't hand-roll it per feature.
- **Paged endpoints take criteria in a NESTED `filter` object.** Sent flat they used to be
  discarded in silence — HTTP 200, well-formed rows, page 1 of the _entire unfiltered table_. The
  engine now rejects a flat _filter field_ with `responseCode -12` naming the offending members,
  but an unknown member that isn't a filter field is still ignored. Also pass `sortBy` /
  `sortDirection` explicitly: the default sort is ascending, which is why "no filter" once looked
  like "the data stops in 2025".
- SignalR: one shared connection to `/api/hubs/trading`
  ([src/app/core/realtime/realtime.service.ts](src/app/core/realtime/realtime.service.ts)).
  Events are dispatched by method name — a server event not in `REALTIME_EVENTS` never reaches the
  UI, which is the usual reason "the page doesn't update live".
- When an engine change crosses the wire, re-run the engine repo's
  `integration-tests/contract-test`.

## Verifying in a browser

A green `ng build` only proves it typechecks. `.claude/skills/browser-verify` drives the app with
Playwright + Chromium, screenshots it, and reports console/network errors.

**Its token-minting auth step is broken** — the hardcoded HS256 dev secret has drifted from the
running engine, so every request 401s and the app bounces to `/login`, which reads as "the whole
page is broken". Use the login form's passwordless **Developer** tab instead:

```js
await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
await page.getByRole('tab', { name: /Developer/i }).click();
await page.getByRole('button', { name: /Sign In/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
```

`require('playwright')` resolves from the **script's** location, not the cwd — keep the driver
inside the repo. Verify against `http://localhost:8080` to test a published release, or `:4200`
for work in progress. A 401 on `/auth/whoami` before sign-in is the normal cold-session probe, not
a regression.

## Directory map

```
src/app/
  core/       api (envelope, optimistic updates), auth, config, realtime, polling, stores,
              feature-flags, scope (account scoping), assistant, keyboard, theme, observability
  shared/     DataTable, ChartCard, StatusBadge, trading-chart, form-field, command palette
  features/   one folder per feature (65) — orders, positions, ea-instances, market-data,
              martingale, spot-sweep, llm-backtest, analysis-monitors, …
  layout/     sidebar, header, breadcrumbs, shell
public/       config.json (runtime config + feature flags), icons, manifest
scripts/      release.sh (deploy), generate-icons.mjs, bundle-stats.mjs
docs/         TUNNEL.md (tunnel/proxy runbook), specs and plans
```

Path aliases: `@core/*`, `@shared/*`, `@features/*`, `@env/*` — set in `tsconfig.json` and mirrored
in `vitest.config.mts`. Adding one means editing both.

### Pine scripts (engine ADR-0027)

Script strategies are authored, backtested and watched live in `features/scripting/`: the CodeMirror 6
Pine mode and its catalog-driven autocomplete, hover and signature help (`pine/`, `components/pine-editor`),
the inputs form, the Strategy report, script backtests, live status, alerts, the screener and the libraries
page. `shared/pine-chart` draws every plot, drawing and table a script outputs. The wire contract is the
engine's `docs/api/scripting-api.md`; the language catalog comes from `GET scripting/catalog` (ETag-cached),
so a new built-in needs no console change.

- **Units vs lots.** Pine quantities are TradingView units (`qty = 100000` = one EURUSD lot). The report,
  replay and live emulator speak units; broker positions and backtest lot columns speak lots. Label which
  one a number is — the live tab shows both.
- **Script backtests send no `initialBalance`.** The engine takes the script's `initial_capital` (or its
  default), and the form shows that capital read-only with its source.
- **Submit for approval is a background job.** `POST strategy/{id}/submit-for-approval` returns a job id
  at once; poll `GET …/submit-for-approval/{jobId}`. A synchronous call died at the ~100 s tunnel cut-off.
- **Paper-only stage.** A Paused Draft script gets "Start paper trading" on its detail page
  (`PUT strategy/{id}/start-paper-trading`, Draft → PaperTrading: paper executions, no gates, nothing sent to
  an account); "Stop paper trading" moves it back. A PaperTrading script is submitted for approval like a
  Draft, and an activation refusal points it there too (`util/activation.ts`).
- **Lifecycle actions answer HTTP 200 with `status: false` when refused** — read the envelope, not just the
  transport. Delete is refused for a script strategy that still holds positions (engine D131).
- `/pine-chart-lab` is a development page: always on under `ng serve`, and in a release only where the
  `pine-chart-lab` flag admits (Admin only, off in `config.json`).

## Gotchas that have cost real time

- **Account-scoped effects need both `accountIdsKey` and `untracked`.** Either half alone leaves a
  30-second refetch storm:

  ```ts
  effect(() => {
    this.accountScope.accountIdsKey(); // a string — stable across refreshes
    untracked(() => {
      this.reloadTable();
      this.loadSummary();
    }); // body must not track
  });
  ```

- **Component SCSS has a hard 28 kB error budget** (`anyComponentStyle` in `angular.json`, raised
  from 24 kB). Three components already exceed the 16 kB warning; `market-data-page` is the worst
  at ~26 kB and the honest fix is splitting the page, not raising the budget again.
- **Backtest metric units:** `TotalReturn` and `MaxDrawdownPct` are already percentages,
  `WinRate` is a fraction. Don't rescale client-side.
- `eslint` must keep ignoring `storybook-static/` and `.tmp-workflows/` — they are build output and
  produced 21 phantom errors before `eslint.config.mjs` was told to skip them.

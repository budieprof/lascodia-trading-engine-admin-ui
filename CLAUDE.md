# Lascodia Admin UI — Development Guide

## What this is

The operator console for the Lascodia Trading Engine. Angular 22 (standalone components,
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
  UI, which is the usual reason "the page doesn't update live". Warm chart sessions' `scriptFrame` comes on
  a SECOND hub, `/api/hubs/scripting` (`core/realtime/scripting-realtime.service.ts`, connected only while a
  session is subscribed): the engine may serve `scripting/*` from another process (SS-I4).
- When an engine change crosses the wire, re-run the engine repo's
  `integration-tests/contract-test`.

## Sign-in, organisations and permissions (multi-tenancy W3)

- **Two sign-in modes, one flag.** `config.json` → `featureFlags.bffAuth` (only `true` or
  `{ "enabled": true }` turns it on; `core/auth/auth-mode.ts`). Off (default): today's Admin /
  Operator forms, JWT in `sessionStorage`, bearer header. On: one "Sign in" button to the engine's
  BFF (`/bff/login` → Keycloak), the session from `GET /bff/session` in an app initializer, cookie-only
  calls with `X-CSRF-Token` on unsafe methods (`csrf.interceptor.ts`; a `-403-csrf` re-reads the
  session and retries once), SignalR on a single-use `?ticket=` (WebSockets, negotiation skipped —
  `realtime/hub-auth.ts`), sign-out via `POST /bff/logout` → Keycloak, idle sign-out ON from the
  session's `idleTimeoutSeconds` (judged across tabs). `AuthService` is the one surface for both.
- **Gate by permission key, never by role.** `core/auth/route-access.ts` is the ONE table the route
  guards (`canAccessPath('orders')`) and the sidebar read — a new page gets an entry there (its read
  endpoint's key, from the engine's endpoint map), a sub-page adds to its parent. In templates use
  `*lscCan="'iam.grants.manage'"`; in code `auth.hasPermission(Permission.X)`. A session without
  permissions sees nothing privileged — there is no "roleless = full access" fallback any more, so a
  component spec that shows privileged controls must provide them (`core/testing/auth-test-double.ts`).
- **Permission keys are generated.** `docs/permission-catalog.json` is a copy of the engine's;
  `npm run permissions:generate` writes `core/auth/permissions.generated.ts` (`permissions:check`
  fails when stale). A key the console uses that leaves the catalog breaks the typecheck — on purpose.
- **Never touch `localStorage` directly.** Use `appStorage` (`core/storage/app-storage.ts`): every
  `lascodia.*` / `tradingChart.*` key is stored per person and organisation
  (`lascodia.u<id>.t<tenant>.…`). A static spec fails on direct use. Global on purpose: the theme and
  the idle stamp.
- **Switching organisation reloads the console** (`AuthService.switchTenant`): nothing of the previous
  organisation may survive in memory. Step-up (`-401-stepup`) sends the person to
  `/bff/login?acr=mfa` and offers to finish the refused action on return (one click, never automatic);
  a two-person action answers 202 `-202-approval` and is announced as sent for approval.
- **New screens:** `/iam/*` (members, invitations, roles, grants + "why can they?", teams, account
  groups, security policy, SSO + SCIM tokens, approvals, access review), `/account/sessions`,
  `/account/tokens`, `/platform/*` (organisations, elevated access, impersonation + banner),
  `/invite/:token`. Engine DTOs are mapped in `features/iam/iam-adapters.ts` only.

## Verifying in a browser

A green `ng build` only proves it typechecks. `.claude/skills/browser-verify` drives the app with
Playwright + Chromium, screenshots it, and reports console/network errors.

**Signing in.** The login form's passwordless **Developer** tab is gone (both auth modes), and the
engine's dev-token endpoint (`POST /auth/token`) now answers 404 unless explicitly opted in from a
loopback caller (engine f1245cae) — on 2026-10-19 it was found minting a ~1-year Admin JWT for
anyone reaching the public tunnel. Caddy also refuses that path. With `bffAuth` OFF, for automation
mint a JWT from the engine's `JWT_SECRET_KEY` (`.env`) carrying the five identity claims (`passportId`,
`firstName`, `lastName`, `email`, `mobileNo`), `adminUserId: "1"`, `is_superadmin: "true"` and the MS
role claim `["SuperAdmin","Admin","Operator"]`, inject it into `sessionStorage['lascodia.auth.token']`,
and seed `lascodia.auth.perms` with `data.permissions` from `GET /admin/auth/me` (a restored admin
token without cached permissions now loads them before the first route, but seeding saves the round
trip). `tools/visual-review/README.md` has the details. With `bffAuth` ON there is no token to inject:
the session is the HttpOnly `__Host-lascodia-session` cookie from a real Keycloak sign-in at
`/bff/login` — drive the sign-in, or crawl a `serve-dist.js` build whose `config.json` keeps the flag off.

**Never let a driver write to the live engine.** Both :8080 and a local build talk to the LIVE
engine. Every script in `tools/visual-review/` aborts non-GET engine calls except the read-POSTs in
`read-posts.js`; copy that `context.route` block into any new driver before its first click — an
unblocked crawl once sent real Telegram test alerts by clicking a "Send test" button it took for a tab.

**Full review tooling** (`tools/visual-review/`): `crawl.js` (every route + tab, both themes, any
width), `interact.js` (clicks every safe button, records dialogs that ignore Escape, one-click
writes, dead buttons), `modals.js`, `login-shot.js`, and `serve-dist.js` (serves a production build
on :4300 with the Caddy routing, so a fix can be crawled before it is published).

`require('playwright')` resolves from the **script's** location, not the cwd — keep the driver
inside the repo. Verify against `http://localhost:8080` to test a published release, or `:4300`
(`serve-dist.js`) for work in progress. A 401 on `/auth/whoami` before sign-in is the normal
cold-session probe, not a regression.

## Directory map

```
src/app/
  core/       api (envelope, optimistic updates), auth (sign-in, BFF session, permissions,
              route table, step-up), storage (per-person localStorage), config, realtime, polling,
              stores, feature-flags, scope (account scoping), assistant, keyboard, theme, observability
  shared/     DataTable, ChartCard, StatusBadge, trading-chart, form-field, command palette
  features/   one folder per feature (68) — orders, positions, ea-instances, market-data,
              martingale, spot-sweep, llm-backtest, analysis-monitors, …; iam (organisation
              administration), platform (platform console), invite (/invite/:token)
  layout/     sidebar, header, breadcrumbs, shell
public/       config.json (runtime config + feature flags), icons, manifest
scripts/      release.sh (deploy), generate-icons.mjs, bundle-stats.mjs, generate-permissions.mjs
docs/         TUNNEL.md (tunnel/proxy runbook), permission-catalog.json (copy of the engine's), specs
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
- **Scripts on the chart-analysis chart** (`features/chart-analysis/scripts`). Each script keeps one
  renderer by its key (`ScriptLayers`): its pane keeps its height and place, a new result or display setting
  never rebuilds it, and ticks reach it only as an anchor `update()` — never a re-render. Every run goes
  through `LiveRerunScheduler` (one in flight per script, spaced by its round trip, held while the tab is
  hidden); a `-429` busy refusal backs off quietly and is never shown as a script error (contract C5). Runs
  are computed on the bars the chart draws (`chartType: 'heikinashi'` under Heikin-Ashi; price-based styles
  say "not available"), and in Bar Replay every run ends at the head (`toUtc` = the head bar's close) — a
  run that reaches past the head is not drawn, nor read by a status line, table or the Strategy Tester (no
  look-ahead). Style/Visibility apply on the client (`styleRenderModel`, saved in the layout's
  `WorkspaceScript.display`). The dock holds the Pine Editor, the Strategy Tester (the shared report, a
  virtualised List of trades the chart's fill arrows select in, deep backtest for engine strategies) and Pine
  Logs / trace / profiler — the last session-only. Named input templates are a synced chart pref
  (`lascodia.chart.scriptInputTemplates.v1`).
- **Bar Replay** (CC-I4, `features/chart-analysis/replay`): a view over the loaded bars (`ReplayController`) —
  start at a clicked bar or a date (history loaded back to it), step / play / Shift+→ ← ↓, intrabar steps from
  1m (1h above a day) loaded in chunks; scripts run to the last CLOSED bar, indicators step through the engine's
  replay sessions (`replay-script-sessions.ts`, only when the engine window lines up; else full runs). Paper
  trades are browser-only (`paper-broker.ts`: Bid bars, buys at bid + the bar's recorded `spreadPoints`) —
  replay never calls an order path.
- **Layout state v2** (CC-I5, `workspace/workspace-state.ts`): the main chart's v1 fields at the top level,
  the other charts in `charts[]` (own studies, Pine indicators, link group), `link` / `sync`. Every state is
  read through `migrateWorkspaceState` (v1 split panels → `charts`, nothing dropped). Other charts' scripts
  reuse the main chart's identical run (`chart-panels.ts sharedRun`) and re-run per new bar, not per tick.
  One undo history (`undo-history.ts`) covers drawings (store markers), studies, scripts and settings; the
  page asks in `ScriptDialogService` dialogs (`dialog/chart-dialogs.ts`), never `prompt()` / `confirm()`.
- **Live scripts are warm, and say what is not final** (PC-I1, PC-I9). An indicator on the live standard
  chart is run with `keepWarm`; the engine then executes only new candles and quotes and pushes `scriptFrame`
  (≤1/s), which `warm-sessions.ts` folds into the run on the chart (`mergeOutputs`, the replay merge) — no run
  per tick while the scripting hub is connected; a gap resyncs (`GET scripting/sessions/{id}/frame`), a
  reset runs it again. `realtime-truth.ts` fades whatever sits on the forming bar, marks drawings made there
  provisional (tooltip), and flags a plot that changed on an already-closed bar ("Repaints" on the chip).
- **Alerts on chart scripts** (SS-I1): the chip's bell opens `app-chart-script-alert-form` (a saved "My
  scripts" script only — the engine snapshots it); the alert manager's "Script alerts" tab lists, re-arms,
  pauses and logs them; their `alertFired` (`source: 'chart-script'`) pops up only after
  `GET scripting/alerts/{id}` confirms the owner.

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
- **Every dialog, drawer and menu uses `appModalA11y`** (`shared/directives/modal-a11y.directive.ts`):
  focus moves in, Escape closes the topmost one, Tab is trapped (`[appModalA11yTrap]="false"` for
  menus), focus returns to the trigger. Element-level `(keydown.escape)` never fired — focus stayed on
  the trigger — and `autofocus` does nothing on inserted nodes. A confirmation of a consequential
  action puts `data-autofocus` on the SAFE button. The 2026-10-19 review found Escape closed 1 of 7.
- **A consequential write never fires from one click.** Engine-config toggles, modes, pins,
  resolve/discard, activate: confirm first (`app-confirm-dialog`). Read the envelope, not the
  transport: `PUT /config` answers HTTP 200 for applied, `QueuedForCoolingOff` and refused alike —
  use `ConfigUpsertResponse.outcome` / `isQueuedForCoolingOff()`.
- **Component styles stay scoped.** Two ea-instances components leaked `.btn`, `.actions` and `code`
  rules to every page after a visit. No `ViewEncapsulation.None` / global selectors from a feature.
- **Refresh buttons give feedback:** `app-refresh-button` bound to the resource's in-flight flag;
  `resource.loading()` is only the first paint. Refetch-on-input effects use `refetchOnChange`
  (`core/polling`) — a plain effect fires on start-up and cancels the page's first request.
- **"Real" in the account scope means not engine-paper**, not a broker Real account — four of the five
  live accounts are broker Demo. Label by `accountType` (see the header pill).
- **Backtest metric units:** `TotalReturn` and `MaxDrawdownPct` are already percentages,
  `WinRate` is a fraction. Don't rescale client-side.
- `eslint` must keep ignoring `storybook-static/` and `.tmp-workflows/` — they are build output and
  produced 21 phantom errors before `eslint.config.mjs` was told to skip them.

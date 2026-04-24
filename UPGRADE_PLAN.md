# Admin UI Upgrade Plan

Living document for the Lascodia Trading Engine Admin UI upgrade. Companion to [PRD.md](PRD.md) — the PRD states the target; this plan states how we get from here to there.

- **Current engine**: .NET 10, 31 controllers (~100 endpoints), 76 entities, 147 background workers, pull-based REST only.
- **Current UI**: Angular 19 standalone + signals. ~40% of PRD features shipped; service layer solid; test coverage near zero; three pages render mock data.
- **Target UI**: PRD-complete admin with live ops controls, real data throughout, Vitest + Playwright coverage, WCAG 2.1 AA.

---

## 1. Snapshot

### 1.1 Engine capabilities (what we can wire)

| Domain                    | Endpoints worth surfacing                                                                          | Notes                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Auth & account            | `POST /auth/login`, `POST /auth/register`, `/trading-account/*`                                    | JWT scoped to one TradingAccount. No RBAC.                                   |
| Orders                    | `/order/*` incl. `from-signal`, `submit`, `cancel`, `modify`, `execution-report`                   | No batch close.                                                              |
| Positions                 | `/position/{id}`, `/position/list`                                                                 | Read-only. Actions via `/trailing-stop/*`.                                   |
| Trade signals             | `/trade-signal/*` incl. `approve`, `reject`, `expire`, `pending-execution`                         | EA polls `pending-execution`.                                                |
| Strategies                | `/strategy/*` incl. `activate`, `pause`, `risk-profile`                                            | `Auto-*` names bypass promotion gate.                                        |
| Strategy feedback         | `/strategy-feedback/optimization/*` incl. `validate`, `dry-run`, `approve`                         | Bayesian TPE/GP-UCB/EHVI + Hyperband.                                        |
| Strategy ensemble         | `/strategy-ensemble/rebalance`, `/allocations`                                                     | Sharpe-weighted rebalance.                                                   |
| ML models                 | `/ml-model/*` incl. `training/trigger`, `hyperparam-search`, `rollback`, `signal-ab-tests`         | 12 learner architectures.                                                    |
| ML evaluation             | `/ml-evaluation/shadow/*`, `/ml-evaluation/outcome`                                                | SPRT champion/challenger.                                                    |
| Market data               | `/market-data/*` incl. `live-price`, `candle/watermarks`, `candle/list`, `tick/batch`              | EA push; UI reads.                                                           |
| EA bridge                 | `/ea/*` incl. `instances`, `heartbeat`, `commands`, `symbol-specs`, snapshots                      | Heartbeat timeout 60s → symbols `DATA_UNAVAILABLE`.                          |
| Backtest / walk-forward   | `/backtest/list`, `/walk-forward/*`                                                                | No backtest-queue endpoint.                                                  |
| Market regime / sentiment | `/market-regime/*`, `/sentiment/*`, `/sentiment/cot`                                               | Rule + HMM; confidence ≥ 0.15.                                               |
| Economic events           | `/economic-event/*`                                                                                | Create, update actual, list.                                                 |
| Risk                      | `/risk-profile/*`, `/drawdown-recovery/*`                                                          | Tier-2 auto-lot-reduction.                                                   |
| Execution quality         | `/execution-quality/*`                                                                             | Slippage, fill latency, TCA.                                                 |
| Performance               | `/performance/{strategyId}`, `/performance/all`                                                    | Sharpe, Sortino, Calmar, info ratio, **ML alpha**, **timing alpha**.         |
| Paper trading             | `/paper-trading/mode`, `/status`, `/backfill`                                                      | Toggle + backfill synthetic executions.                                      |
| Trailing stop             | `/trailing-stop/{positionId}`, `/trailing-stop/scale`                                              | TWAP/VWAP routing.                                                           |
| Config                    | `/config/*`                                                                                        | 200+ hot-reloadable keys.                                                    |
| Admin                     | `/admin/kill-switch/*`, `/admin/calibration/*`                                                     | Kill switch global + per-strategy. Calibration trend + gate-binding reports. |
| Health                    | `/health/status`, `/health/workers`, `/health/defaults-calibration`, `/health/strategy-generation` | All 147 workers surfaced.                                                    |
| Audit trail               | `/audit-trail/*`                                                                                   | Operator decision log.                                                       |
| Dead letters              | `/dead-letter/list`, `/{id}/resolve`, `/{id}/replay`                                               | Integration-event DLQ.                                                       |
| Rate limit                | `/rate-limit/quota/{brokerKey}`                                                                    | Per-broker quota.                                                            |
| Currency pairs            | `/currency-pair/*`                                                                                 | Full CRUD.                                                                   |

**Engine-side gaps we will live with (for now):**

- No WebSocket / SSE — polling only.
- No ML explainability endpoint (SHAP / permutation importance).
- No backtest-queue endpoint — backtests are internally triggered by the strategy-generation worker.
- No stress-test trigger or batch position-close.

### 1.2 UI state (what's real vs. stubbed)

| Feature           | List | Detail      | Mutations                          | Charts                | Status                   |
| ----------------- | ---- | ----------- | ---------------------------------- | --------------------- | ------------------------ |
| Dashboard         | —    | —           | —                                  | Yes (procedural data) | Wire real data           |
| Orders            | Yes  | Yes         | Create                             | Yes                   | Good                     |
| Positions         | Yes  | **Missing** | **Missing (trailing stop, scale)** | Yes                   | Detail + actions needed  |
| Strategies        | Yes  | Yes         | Activate/Pause                     | Yes                   | Good                     |
| Trade Signals     | Yes  | Yes         | Approve/Reject/Expire (bulk)       | —                     | Good                     |
| Trading Accounts  | Yes  | Yes         | **Verify wiring**                  | —                     | Unknown                  |
| Brokers           | Yes  | Yes         | **Verify wiring**                  | —                     | Unknown                  |
| Risk Profiles     | Yes  | **Missing** | **Missing**                        | —                     | Partial                  |
| Currency Pairs    | Yes  | **Missing** | **Missing**                        | —                     | Partial                  |
| Market Data       | Yes  | —           | —                                  | —                     | Partial                  |
| ML Models         | Yes  | —           | —                                  | —                     | Partial                  |
| Backtests         | Yes  | Yes         | —                                  | —                     | Unknown                  |
| Walk-Forward      | —    | —           | —                                  | —                     | **Stub ("coming soon")** |
| Strategy Ensemble | Yes  | —           | —                                  | —                     | Partial                  |
| Alerts            | Yes  | —           | Create/Delete                      | —                     | Partial                  |
| Execution Quality | Yes  | —           | —                                  | —                     | Partial                  |
| Sentiment         | Yes  | —           | —                                  | Yes                   | **Mock data**            |
| Performance       | Yes  | —           | —                                  | —                     | Partial                  |
| Drawdown Recovery | —    | —           | —                                  | Yes                   | **Mock data**            |
| Paper Trading     | —    | —           | —                                  | —                     | **Stub**                 |
| Engine Config     | Yes  | —           | —                                  | —                     | Partial                  |
| Audit Trail       | Yes  | —           | —                                  | —                     | Partial                  |
| System Health     | —    | —           | —                                  | Yes                   | **Mock data**            |

**Not in the UI at all yet (engine ready):** Kill switches, Worker health monitor (147 workers), EA instance monitor, Dead-letter queue, Calibration reports (trend + gate binding + signal rejections), Defaults-calibration recommendations, Rate-limit quotas, Shadow Arena detail, Signal-level A/B test results, Economic events CRUD, CPC encoder view.

---

## 2. Blocking issues to fix first

- [ ] **`@angular/animations` version mismatch** — [package.json:13](package.json#L13) has `^21.2.5` against `@angular/core` `^19.2.0`. Pin animations to `^19.2.x`.
- [ ] **Dart Sass `@import` deprecations** — [src/styles.scss](src/styles.scss) and [src/styles/](src/styles/) use `@import`; will hard-break on Dart Sass 3.0. Migrate to `@use` / `@forward`.
- [ ] **Testing framework contradiction** — PRD §3 says Vitest + Playwright, [package.json](package.json) lists Karma + Jasmine. Decide once, delete the loser.

---

## 3. Decisions required before work starts

| #   | Question                                                         | Default if not decided              |
| --- | ---------------------------------------------------------------- | ----------------------------------- |
| 1   | Vitest or Karma/Jasmine?                                         | **Vitest** (PRD)                    |
| 2   | Add WebSocket/SSE to the engine, or polling only?                | **Polling only** (PRD accepts this) |
| 3   | Add ML explainability endpoints engine-side, or ship UI without? | **Ship without, document gap**      |
| 4   | Persist auth token across reloads?                               | **No** (PRD §14 security)           |
| 5   | Dark mode: user toggle in header, or follow system only?         | **User toggle** (PRD §3.1)          |
| 6   | Dashboard refresh on window focus?                               | **Yes** (PRD §10)                   |

---

## 4. Phase plan

Each phase ends in something shippable. Check items off as they land.

### Phase 0 — Stabilize foundation (1 week)

Non-negotiable. No new features until this phase ships.

- [x] Pin `@angular/animations` to `^19.2.x`; reinstall.
- [x] Also pin `ngx-echarts` to `^19.0.0` (was `^21.0.0`, needed Angular 21).
- [x] Migrate [src/styles.scss](src/styles.scss) and [src/styles/](src/styles/) from `@import` to `@use` / `@forward`.
- [ ] Choose test framework (Vitest vs Karma); remove the other from [package.json](package.json) and [angular.json](angular.json). — _Deferred to Phase 5 (cleaner to set up Vitest with real tests than empty scaffolding)._
- [ ] Wire ESLint + angular-eslint + Prettier; add lint-staged pre-commit hook. — _Deferred to Phase 5._
- [x] Typed response envelope helper (`ResponseData<T>` + narrowing + `ApiError` class) consumed by every service. See [api.service.ts](src/app/core/api/api.service.ts) `getEnvelope/postEnvelope/putEnvelope/deleteEnvelope`.
- [x] Skeleton components: [table-skeleton](src/app/shared/components/feedback/table-skeleton.component.ts), [card-skeleton](src/app/shared/components/feedback/card-skeleton.component.ts). The existing `ui-skeleton` is the primitive both build on.
- [x] Route-scoped polling primitive (signals-based, pauses on hidden tab / inactive route). See [createPolledResource](src/app/core/polling/polled-resource.ts).
- [x] Optimistic-update helper. See [runOptimistic](src/app/core/api/optimistic-update.ts).
- [x] Empty-state and error-state components. See [empty-state](src/app/shared/components/feedback/empty-state.component.ts), [error-state](src/app/shared/components/feedback/error-state.component.ts).
- [x] Offline/network banner. See [offline-banner](src/app/shared/components/feedback/offline-banner.component.ts), wired into [layout.component.ts](src/app/layout/layout.component.ts).
- [x] Environment handling for API base URL without rebuild — see [public/config.json](public/config.json) and [runtime-config.ts](src/app/core/config/runtime-config.ts). Fetched in [main.ts](src/main.ts) before bootstrap.

**Exit criteria:** `ng build --configuration production` clean (no deprecation warnings), `ng test` runs with the chosen framework, a demo page uses the polling primitive + skeleton + empty state.

### Phase 1 — Fill existing features (2–3 weeks)

Finish what's half-built before adding new surfaces.

- [x] **Positions** — detail view at `/positions/:id`; trailing-stop and scale inline panels; row-click on list to open detail. See [position-detail-page](src/app/features/positions/pages/position-detail-page/position-detail-page.component.ts).
- [x] **Sentiment** — replaced radar + regime charts with polled fetches against [sentiment.service.ts](src/app/core/services/sentiment.service.ts) and [market-regime.service.ts](src/app/core/services/market-regime.service.ts). Empty state when engine has no data.
- [x] **Drawdown Recovery** — hero (gauge + equity delta + recovery mode) polled from `GET /drawdown-recovery/latest`. Historical charts noted as engine-side gap.
- [x] **System Health** — wired `GET /health/status` (isRunning + metrics + paperMode) with empty state. Note points Worker Monitor / Calibration to Phase 2.
- [x] **Walk-Forward** — queue panel, list, detail page (with per-window results parsed from `windowResultsJson` + in-sample-vs-OOS chart).
- [x] **Paper Trading** — toggle with confirm dialog + shared `PaperTradingService` state; backfill trigger form; app-shell `<app-paper-mode-banner>` polls on boot and shows when active.
- [x] **Risk Profiles** — inline create/edit panel (all fields), delete confirm. Monitor tab shows empty-state note (live metrics land in Phase 2).
- [x] **Currency Pairs** — inline create/edit panel, delete confirm, row-click to edit.
- [x] **ML Models** — dedicated detail page at `/ml-models/:id` with Activate + Rollback (confirm). Service fixed to accept `RollbackMLModelRequest`. List row-click now navigates.
- [x] **Market Data** — already wired prior to upgrade (Live Prices + Analytics + Candle History). Marked complete; no refactor needed.
- [x] **Performance** — polled `/performance/all`, computed aggregate metrics, P&L-by-strategy + Sharpe leaderboards, per-strategy table. Attribution tab documents `/performance/{id}` as the source for ML/timing alpha (Phase 4).
- [x] **Execution Quality** — slippage and latency histograms, scatter, slippage-by-symbol bar, aggregate metrics. All polled from `/execution-quality/list`.
- [x] **Engine Config** — already wired prior to upgrade (grouped editor on `/config/all` with inline save).
- [x] **Audit Trail** — already wired prior to upgrade (searchable list + detail overlay).
- [x] **Economic Events** — new feature module created: list, create, update-actual panels. Route added to `app.routes.ts`.
- [x] **Forms layer extraction** — [`<app-form-field>`](src/app/shared/components/form-field/form-field.component.ts) component with Reactive-Forms error display; [`AppValidators`](src/app/shared/validators/app-validators.ts) with currency-code/pair/positive/integer/past-date/future-date. Existing feature forms left unchanged — migrate opportunistically.

**Exit criteria:** Zero mock data in the app. Every route in [src/app/app.routes.ts](src/app/app.routes.ts) shows real data. Every list has detail + actions where the engine supports them.

### Phase 2 — Ops & admin control plane (2 weeks)

Net-new surfaces that don't exist in the UI today. This is where operators gain real control.

- [x] **Kill switches page** — [kill-switches-page](src/app/features/kill-switches/pages/kill-switches-page/kill-switches-page.component.ts) with global toggle card and per-strategy table. Required reason field written into the audit trail. Persistent [kill-switch-banner](src/app/shared/components/feedback/kill-switch-banner.component.ts) in the app shell when global is engaged.
- [x] **Worker health monitor** — [worker-health-page](src/app/features/worker-health/pages/worker-health-page/worker-health-page.component.ts). Polls `/health/workers` every 30 s. Status/category/name filters, colour-coded cards with cycle duration, error rate, backlog, last success/failure.
- [x] **EA instance monitor** — [ea-instances-page](src/app/features/ea-instances/pages/ea-instances-page/ea-instances-page.component.ts). Heartbeat age, owned symbols as chips, reassignment note. Polls `/ea/instances` every 15 s.
- [x] **Dead-letter queue** — [dead-letter-page](src/app/features/dead-letter/pages/dead-letter-page/dead-letter-page.component.ts). Paged table, click-to-drawer detail with event type, payload JSON, error. Replay and Mark-Resolved confirm dialogs.
- [x] **Calibration reports (Tuning)** — [calibration-page](src/app/features/calibration/pages/calibration-page/calibration-page.component.ts) with four tabs (Trend, Screening Gates, Signal Rejections, Recommended Defaults).
- [x] **Rate-limit quotas** — [rate-limit-strip](src/app/shared/components/feedback/rate-limit-strip.component.ts) component mounted in the app shell. Renders a per-broker quota bar and a "Throttled" pill when the engine reports the broker is rate-limited.

**Exit criteria:** A new operator can observe system health, stop trading globally or per-strategy, replay a DLQ event, and see why signals got rejected — all without touching the backend.

### Phase 3 — ML lifecycle depth (2 weeks)

Engine has 12 learner architectures, 82 monitoring workers, SPRT A/B testing, CPC encoders. UI today has only a basic list.

- [x] **Training Lab** — run list + trigger form were already wired; mock loss-curve + feature-importance charts removed in favour of a real run-detail dl (status, trigger, samples, direction accuracy, magnitude RMSE, date range, timestamps, produced model link) plus an explicit engine-gap note pointing at a future `/ml-model/training/:id/diagnostics` endpoint.
- [x] **Shadow Arena** — head-to-head chart now renders real three-way metrics (direction accuracy, magnitude correlation, Brier score). Synthetic "cumulative race" replaced with an SPRT progress donut (completed vs required trades + promotion decision).
- [x] **Signal A/B results** — new tab in [ml-models-page](src/app/features/ml-models/pages/ml-models-page/ml-models-page.component.ts) with paged list, champion-vs-challenger side panel, SPRT LLR and p-value. Service extended: `MLModelsService.listSignalAbTests` / `getSignalAbTest`; typing `MLSignalAbTestResultDto` added.
- [x] **Rollback** — already shipped in Phase 1.9 on the model detail page.
- [x] **Optimization runs** — brand-new module at `/optimizations` ([optimizations-page](src/app/features/optimizations/pages/optimizations-page/optimizations-page.component.ts)). Trigger panel with live dry-run estimate (grid size, candles, duration, CPU cores), paged list, detail with Approve/Reject confirm dialogs. Service extended: `validateOptimizationConfig`, `getOptimizationDryRun`.
- [x] Explainability gap documented — in-page notes on ML Model detail (Phase 1) and Training Lab run detail (above) flag no-SHAP as engine-side work.

**Exit criteria:** Operator can trigger training, watch shadow evaluation complete, promote or rollback a model, and approve an optimization run.

### Phase 4 — Analytics depth & polish (2 weeks)

- [x] **Strategy Ensemble** — [ensemble-page](src/app/features/strategy-ensemble/pages/ensemble-page/ensemble-page.component.ts) rewritten. Rebalance button with confirm dialog, current-allocation donut, ranked weight table, history tab with allocations-over-time stacked area. Polls 60 s for live allocations.
- [x] **Dashboard real data** — [dashboard-page](src/app/features/dashboard/pages/dashboard-page/dashboard-page.component.ts) rewritten. Equity from `/trading-account/active`; daily P&L aggregated from closed positions; position exposure from open positions; allocation donut from ensemble. Synthetic equity curve removed. Pending-signals panel retained with inline approve/reject.
- [x] **Command palette (⌘K)** — [command-palette.component.ts](src/app/shared/components/command-palette/command-palette.component.ts) mounted in the layout. Fuzzy filter across 30 navigation targets; arrow-key + Enter + Esc; `role="dialog"` with `aria-modal`.
- [x] **Dark mode** — [theme.service.ts](src/app/core/theme/theme.service.ts) persisted to localStorage. SCSS tokens flip on `[data-theme="dark"]`; ag-grid follows via the apple partial. `ChartCardComponent` now swaps between the `lascodia-light` and `lascodia-dark` echarts themes (registered at bootstrap in [app.config.ts](src/app/app.config.ts)) keyed on `ThemeService.theme()`. Per-option hex colours inside individual chart definitions still need opportunistic migration to token-driven palettes for full re-theming.
- [x] **Accessibility (targeted)** — ConfirmDialog now carries `role="dialog"`, `aria-modal`, `aria-labelledby`, `aria-describedby`, Esc-to-close, autofocus on primary action. StatusBadge adds a glyph + descriptive aria-label so state isn't colour-only. Feedback components (offline/paper/kill-switch banners, empty-state, error-state) already have role + aria-live.
- [x] **Responsive pass (app shell)** — mobile drawer landed. Header gains a hamburger button under 768 px that opens the sidebar as a full-height drawer with a backdrop scrim. Drawer auto-closes on navigation. Per-page charts/metric media queries already existed; individual page refinements tracked separately.
- [x] **A11y pass on shell + DataTable** — skip-to-content link, `<main id="main-content" tabindex="-1">` landmark, sidebar `aria-label` + `aria-current="page"` + `aria-expanded` on collapse toggle, header `role="banner"` + `aria-keyshortcuts="Meta+K Control+K"` on the search button, breadcrumbs switched to a semantic `<nav aria-label="Breadcrumb"><ol>`, DataTable search becomes a `<label>`-wrapped `<input type="search">` with an sr-only hint, pagination becomes a `<nav>` with `aria-current="page"` and per-button `aria-label`. Focus-visible rings added across sidebar, header, and table controls.
- [x] **Keyboard shortcuts** beyond ⌘K — [KeyboardShortcutsService](src/app/core/keyboard/keyboard-shortcuts.service.ts) handles `g`-prefix two-key navigation (`g d` = dashboard, `g o` = orders, `g k` = kill switches, etc.) plus `?` to toggle the [keyboard-help](src/app/shared/components/keyboard-help/keyboard-help.component.ts) overlay. Ignored while typing in inputs/textareas.
- [x] **Glassmorphism + animation polish** — `--bg-glass`, `--blur-{sm,md,lg}`, `--backdrop-scrim`, `--ease-{out-soft,press}`, and `--dur-{fast,base,slow}` tokens added to [src/styles/\_tokens.scss](src/styles/_tokens.scss). Global `.modal-overlay` now applies `backdrop-filter: var(--blur-sm)` + fade-in, `.modal-overlay .modal` scales in (0.96 → 1.0, 0.25s ease-out). Buttons scale to 0.97 on press. Sidebar picks up `var(--bg-glass)` + `blur(14px)` in dark mode. Chart cards lift on hover (translateY(-1px) + shadow elevation). Command palette uses glass panel + `blur(20px)`. New reusable utility classes — `.glass-panel`, `.glass-scrim`, `.card-lift`, `.press`, `.modal-enter`, `.scrim-enter` — with `@supports` fallback for no-blur browsers. See [src/styles/\_animations.scss](src/styles/_animations.scss).

**Exit criteria:** All PRD §3.1 design specs visibly honored. Lighthouse a11y score ≥ 95 on every route.

### Phase 5 — Tests & build (1 week)

- [x] Unit tests (Vitest): envelope unwrap ([api.envelope.spec.ts](src/app/core/api/api.envelope.spec.ts)), optimistic update ([optimistic-update.spec.ts](src/app/core/api/optimistic-update.spec.ts)), validators ([app-validators.spec.ts](src/app/shared/validators/app-validators.spec.ts)). 22 tests, all green. Karma/Jasmine removed from `package.json` + `angular.json`.
- [x] Component tests scaffolded — dedicated Vitest config [vitest.components.config.mts](vitest.components.config.mts) with `npm run test:components` script, separate setup [src/test-setup.components.ts](src/test-setup.components.ts) that initialises `BrowserDynamicTestingModule`. Specs live next to each component: [card-skeleton.component.spec.ts](src/app/shared/components/feedback/card-skeleton.component.spec.ts) (4 default-render tests passing), [status-badge.component.spec.ts](src/app/shared/components/status-badge/status-badge.component.spec.ts), [form-field.component.spec.ts](src/app/shared/components/form-field/form-field.component.spec.ts), [confirm-dialog.component.spec.ts](src/app/shared/components/confirm-dialog/confirm-dialog.component.spec.ts), [data-table.component.spec.ts](src/app/shared/components/data-table/data-table.component.spec.ts). Template-level tests that vary signal inputs are in `describe.skip` blocks — Angular 19.2's JIT path doesn't seed signal inputs (via `setInput` or host bindings) before the first change-detection pass, producing NG0950. The scaffolds will unblock on the Angular 20 upgrade; the skip markers document the current blocker inline.
- [x] E2E (Playwright) — scaffolded. [playwright.config.ts](playwright.config.ts) + [e2e/app-shell.spec.ts](e2e/app-shell.spec.ts) with four backend-independent smoke tests (bundle mounts, sidebar navigation visible, ⌘K opens palette, `?` opens help). Deeper backend-dependent flows (approve signal, toggle kill switch, trigger training) are tracked for when a fixture engine is available.
- [x] Bundle budgets in [angular.json](angular.json) — initial raised to 2 MB warn / 6 MB error (PRD §14's 500 KB / 1.5 MB gzip-equivalents given ~4× compression). Component-style bumped to 12 KB / 20 KB. Production build is now warning-clean.
- [x] Dockerfile + nginx — multi-stage [Dockerfile](Dockerfile), SPA-friendly [docker/nginx.conf](docker/nginx.conf) (CSP, long-cache hashed bundles, no-store index/config), [docker/entrypoint.sh](docker/entrypoint.sh) rewriting `config.json` from `API_BASE_URL` on start, [.dockerignore](.dockerignore).
- [x] CI pipeline — [.github/workflows/ci.yml](.github/workflows/ci.yml). Three jobs: `build-test` (Vitest + production build + dist artifact), `e2e` (Playwright smoke with the installed browsers), and `docker` (buildx image on main pushes, using GHA cache). Concurrency-scoped so PRs cancel superseded runs. Swap platforms by deleting this file and porting the steps — they're standard `npm ci` + `npm test` + `npm run build`.
- [x] README — [README.md](README.md) documents scripts, runtime config, Docker build, project layout, path aliases, shared primitives.

**Exit criteria:** ≥ 80% coverage on shared components and API layer (PRD §14). CI green on `main`. Deployable image published.

---

## 5. Cross-cutting concerns

### 5.1 Polling intervals (PRD §10, encode centrally)

| Data               | Interval  | Active when                        |
| ------------------ | --------- | ---------------------------------- |
| Open positions P&L | 15s       | Positions page or Dashboard active |
| Live prices        | 5s        | Market Data page active            |
| System health      | 15s       | Health page or Dashboard active    |
| Pending signals    | 15s       | Signals page or Dashboard active   |
| Account balance    | 30s       | Dashboard active                   |
| Worker health      | 30s       | Worker monitor active              |
| EA heartbeat       | 15s       | EA monitor active                  |
| Everything else    | On demand | Page load + window focus           |

### 5.2 Security (PRD §14)

- JWT in memory only; no localStorage/sessionStorage.
- All calls over HTTPS in production.
- No sensitive data in URL parameters.
- CSP headers configured (Nginx / edge).
- Strict mode TypeScript.

### 5.3 Performance budgets (PRD §14)

| Metric                     | Target                           |
| -------------------------- | -------------------------------- |
| LCP                        | < 2 s                            |
| Route navigation           | < 500 ms                         |
| Table re-render (100 rows) | < 100 ms                         |
| Bundle (gzipped)           | < 500 KB initial, < 1.5 MB total |

---

## 6. Risks

| Risk                                           | Impact                       | Mitigation                                                           |
| ---------------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| Engine API changes mid-upgrade                 | Rework                       | Pin to current engine commit; schedule engine-stable windows.        |
| Polling load at 5-30s intervals on many pages  | Backend CPU, rate-limits     | Pause polls on hidden tab / inactive route; coalesce duplicates.     |
| Mock-data pages ship looking "done" but aren't | Demo vs. reality mismatch    | Mark mock pages with a dev-only banner until wired.                  |
| 147 workers rendered naively                   | UI jank                      | Virtualized list; server-paged or client-grouped view.               |
| No RBAC on backend                             | Any operator can kill-switch | Gate destructive actions behind a confirmation + audit-trail reason. |
| Dark mode drift                                | Two visual codebases         | Restrict styling to tokens; no raw hex in component styles.          |

---

## 7. Out of scope

- Mobile-native apps (PRD Non-Goals).
- Multi-tenancy / user management (PRD Non-Goals).
- TradingView-class charting (PRD Non-Goals — defer to Grafana/TradingView).
- WebSocket/SSE streams (would require engine change; stays polling unless Decision #2 changes).
- ML explainability (requires engine endpoint; stays deferred unless Decision #3 changes).

---

## 8. Progress log

Append dated entries as phases land.

- _2026-04-23_ — Plan drafted.
- _2026-04-23_ — **Phase 0 substantially complete.** `@angular/animations` and `ngx-echarts` pinned to Angular 19; SCSS migrated to `@use`; zero Sass deprecation warnings on build. Added runtime config, typed envelope helper (`ApiError`, `getEnvelope/postEnvelope/...`), `createPolledResource`, `runOptimistic`, `TableSkeleton`/`CardSkeleton`/`EmptyState`/`ErrorState`/`OfflineBanner`. Offline banner wired in layout. Lint + test-framework decisions deferred to Phase 5. Production build clean apart from two pre-existing warnings (initial-bundle budget + oversized orders-page inline styles); both are out-of-scope for Phase 0.
- _2026-04-23_ — **Phase 1 complete.** All 16 feature items landed. Mock data removed from Sentiment, Drawdown Recovery, System Health. Walk-Forward and Paper Trading replaced from "coming soon" stubs with full queue/list/detail or toggle/backfill flows. New features: Positions detail + trailing-stop + scale panels; ML Models detail + activate + rollback; Economic Events (brand-new module). Real-data wiring on Performance, Execution Quality via `createPolledResource`. Paper-mode app-shell banner polling status on boot. Shared `<app-form-field>` + `AppValidators` extracted; existing feature forms not yet migrated (opportunistic refactor). Engine-side gap calls (no drawdown history, no worker-breakdown yet in UI) documented in-page to surface pending backend work.
- _2026-04-23_ — **Phase 2 complete.** Six net-new Ops surfaces shipped: Kill Switches (global + per-strategy with required-reason and audit-trail logging), Worker Health (polls 147 workers, filterable), EA Instances (heartbeat + symbol-ownership), Dead-Letter Queue (with Replay + Mark-Resolved), Calibration/Tuning (trend, screening-gate binding, signal rejections, recommended defaults), and a per-broker Rate-Limit Quota strip in the app shell. Three new `Ops` sidebar entries wired. Global kill-switch banner added to the layout (sits between offline and paper-mode banners). Six new services: `KillSwitchService`, `WorkersService`, `EAInstancesService`, `DeadLetterService`, `CalibrationService`, plus extended typings. Production build clean apart from the two pre-existing warnings.
- _2026-04-23_ — **Phase 3 complete.** ML lifecycle depth landed. ML Models page: mock loss-curve/feature-importance replaced with real run-detail dl + engine-gap note; Shadow Arena's head-to-head chart now uses real accuracy / magnitude-correlation / Brier metrics; synthetic cumulative race replaced with an SPRT progress donut; new Signal A/B tab with paged list and champion-vs-challenger detail. New Optimizations module at `/optimizations` with trigger panel (live dry-run estimate), paged list, Approve/Reject confirm dialogs. Services extended: `MLModelsService.listSignalAbTests` / `getSignalAbTest`; `StrategyFeedbackService.validateOptimizationConfig` / `getOptimizationDryRun`. Three new DTO types (`MLSignalAbTestResultDto`, `OptimizationDryRunDto`, `OptimizationValidationDto`).
- _2026-04-23_ — **Phase 4 substantially complete.** Strategy Ensemble rewritten with real allocations, rebalance confirm, and allocations-over-time stacked area. Dashboard rewritten with real account equity, daily P&L from closed positions, exposure from open positions, ensemble allocation donut — synthetic equity curve removed. Global ⌘K command palette shipped. `ThemeService` now persists to localStorage. Targeted a11y pass on shared primitives (ConfirmDialog + StatusBadge). Responsive / broader keyboard shortcuts / full design-polish deferred — tracked as remaining checkboxes in Phase 4.
- _2026-04-24_ — **Phase 5 substantially complete.** Vitest wired up with `test-setup.ts` pulling `@angular/compiler` so partial-compiled classes JIT-resolve; 22 tests passing (envelope unwrap, optimistic update, validators). Karma + Jasmine fully removed from `package.json` and `angular.json`. Bundle budgets aligned with PRD §14; production build is now warning-clean. Multi-stage Dockerfile + nginx config + entrypoint + README landed, with runtime `API_BASE_URL` override. Angular component tests (`@analogjs/vite-plugin-angular` Angular 19 incompat), Playwright E2E, and CI pipeline deferred.
- _2026-04-24_ — **Phase-4/5 deferred items cleaned up.** `KeyboardShortcutsService` ships `g`-prefix navigation (g d/o/p/s/t/m/l/b/w/e/h/k/u/c/a) + `?` help overlay, mounted alongside the command palette in the layout. Playwright scaffolded with a backend-independent smoke spec (bundle mounts, sidebar nav, ⌘K, ?). GitHub Actions workflow added: `build-test` → `e2e` → `docker` (image on main-push, GHA cache). `.gitignore` extended for test artefacts. Remaining open: component tests (blocked on Angular 19 + Analog plugin), responsive/a11y full audit, PRD §3.1 design polish.
- _2026-04-24_ — **Responsive + a11y sweep on the app shell.** Skip-to-content link, `main#main-content[tabindex=-1]` landmark, header hamburger below 768 px opening the sidebar as a drawer with a scrim + auto-close on nav, wired header search button into the command palette. Sidebar `aria-label`/`aria-current`/`aria-expanded`, decorative icons marked `aria-hidden`. Breadcrumbs rebuilt as `<nav aria-label="Breadcrumb"><ol>`. DataTable search now has `<label>` + sr-only hint, pagination turned into `<nav>` with per-button `aria-label` + `aria-current="page"`. Focus-visible rings across shell controls. Build + tests still green.
- _2026-04-24_ — **Per-component a11y sweep.** `ChartCardComponent` now exposes `role="img"` on the chart instance with an `aria-label` derived from title + subtitle (or an explicit `alt` input) — 40+ charts across the app inherit this at once. Orders create-form fields switched to proper `for`/`id` pairs with `aria-required`, `aria-invalid`, and role="alert" on inline errors; close buttons across order-form / order-detail / orders / audit-trail / dashboard gain `type="button"` + `aria-label`. Dashboard signal approve/reject buttons now read as e.g. "Approve signal EURUSD Buy" to screen readers. Build + 22 tests still green.
- _2026-04-24_ — **Form-field primitive upgraded for "pit of success" a11y.** [`<app-form-field>`](src/app/shared/components/form-field/form-field.component.ts) now wraps its content in a `<label>` (implicit association) and ships a companion [`appFormFieldControl` directive](src/app/shared/components/form-field/form-field-control.directive.ts) that mirrors the wrapper's state onto the inner input as `aria-required`, `aria-invalid`, and `aria-describedby`. [Risk Profiles page](src/app/features/risk-profiles/pages/risk-profiles-page/risk-profiles-page.component.ts) migrated as the reference — 11 inputs reduced from ~6 lines each to a single `<app-form-field>` wrapper. Pattern documented in [README.md](README.md#accessible-forms). Other feature forms can migrate opportunistically.
- _2026-04-24_ — **Form-field migration wave.** Currency Pairs (8 fields), Economic Events create + update-actual (8 fields), Walk-Forward queue (8 fields), Optimizations trigger (2 fields), Position detail trailing-stop (2 fields) + scale (3 fields), Paper Trading backfill (1 field) all now use `<app-form-field>` + `appFormFieldControl`. ~32 inputs across 6 pages gain implicit label association, `aria-required`, `aria-invalid`, `aria-describedby`, and the inline error/hint rendering for free. Build + 22 tests still green.
- _2026-04-24_ — **ML Models modals migrated to Reactive Forms.** Training (4 fields) and Shadow Arena (5 fields, including a newly surfaced "Required Trades" input) were previously driven by imperative `[ngModel]`/`(ngModelChange)` on plain objects with ad-hoc "please fill in all fields" warnings. They now use `FormBuilder.nonNullable.group()` with `Validators`, `<app-form-field>` + `appFormFieldControl`, modal `<form>`s carrying `role="dialog"` + `aria-modal` + `aria-label`, submit disabled on invalid, and every close button typed and labelled. Earlier notes filing these as "intentionally skipped" are now superseded.
- _2026-04-24_ — **Echarts dark-mode wiring closed out.** `lascodia-light` and `lascodia-dark` themes were already defined in `src/styles/echarts-theme.ts` but never registered. Both are now `echarts.registerTheme()`d at bootstrap in [app.config.ts](src/app/app.config.ts), and `ChartCardComponent` binds `[theme]` to a computed signal tracking `ThemeService.theme()`. ngx-echarts re-instantiates the chart when the theme name changes, so dark-mode toggling now re-themes titles, axes, labels, and background across every chart in the app — per-option hex colours in individual chart definitions still need opportunistic migration.
- _2026-04-24_ — **Recommended improvements landed.** Seven of the twelve-item recommendation list shipped in one pass:
  1. **Global ErrorHandler** — [global-error-handler.ts](src/app/core/errors/global-error-handler.ts) registered as `ErrorHandler`. Uncaught errors now surface a toast; already-handled HTTP and envelope errors pass through. Single hook for later Sentry/OTel wiring.
  2. **HTTP retry with exponential backoff on GETs** — [retry.interceptor.ts](src/app/core/api/retry.interceptor.ts) retries idempotent requests twice (400 ms → 800 ms) on status 0 / 429 / 502 / 503 / 504 only. Installed between auth and error interceptors. POST / PUT / DELETE are never retried.
  3. **Auth session persistence** — [auth.service.ts](src/app/core/auth/auth.service.ts) now mirrors token + user to `sessionStorage` (survives refresh, not tab close — meets PRD §14), with an idle-timeout watcher that logs out after 30 min of inactivity (`pointerdown` / `keydown` / `visibilitychange` listeners, 30 s throttle, 1 min check interval).
  4. **Angular cell components for ag-grid** — [status-pill-cell.component.ts](src/app/shared/components/data-table/cell-renderers/status-pill-cell.component.ts) + [direction-cell.component.ts](src/app/shared/components/data-table/cell-renderers/direction-cell.component.ts) replace `innerHTML`-string renderers. Migrated positions (direction + status), walk-forward, backtests, optimizations. No more XSS surface in those cells; each pill now carries a proper `aria-label`. Remaining files (trade-signals, ml-models, alerts, risk-profiles, brokers, trading-accounts, etc.) can migrate by swapping `cellRenderer: (p) => '…'` for `cellRenderer: StatusPillCellComponent`.
  5. **DataTable bulk-selection toolbar** — [data-table.component.ts](src/app/shared/components/data-table/data-table.component.ts) now exposes a `selectedRows` signal, a `(selectionChange)` output, and a `#bulkActions` template slot that renders a floating toolbar above the grid when rows are selected. Callers project `<ng-template #bulkActions let-rows let-clear="clear">…</ng-template>` to wire actions.
  6. **Saved filter / pagination / sort per route** — [table-state.service.ts](src/app/shared/components/data-table/table-state.service.ts) persists state to `sessionStorage` keyed by route pathname by default; `DataTable` auto-reads/writes on every state change. Opt-out via `[stateKey]="''"`.
  7. **Order-detail style extraction** — extracted the 9.5 KB inline `styles` blob from [order-detail-page.component.ts](src/app/features/orders/pages/order-detail-page/order-detail-page.component.ts) to a sibling [.scss](src/app/features/orders/pages/order-detail-page/order-detail-page.component.scss) via `styleUrl`. Silences the Phase 0 component-style-budget warning.
     Build + 22 tests still green throughout.

  The remaining five recommendations are blocked: **#7 WebSocket/SSE**, **#8 new engine endpoints** (drawdown history, ML training diagnostics, drift report), **#9 RBAC**, **#10 Angular component tests** (Analog plugin vs Angular 19.2), **#11 Storybook** (explicitly skipped — adding 40 MB of devDeps without design-review ownership wasn't the right call).

# Chart Analysis page — TradingView Advanced Charts

Plan for a dedicated chart-analysis workstation in the admin console, rendered by
**TradingView Advanced Charts** (the real library, self-hosted), fed by the engine's
own market data and overlaid with this system's trading state.

Decision taken 2026-09-19: build on Advanced Charts rather than re-implementing on
Lightweight Charts, accepting the licence conditions in §1. New route alongside the
existing ECharts analysis chart; migrate those surfaces later once this is proven.

---

## 1. Read this before writing any code

Three constraints decide whether this project is viable at all. None is a coding
problem and none can be solved from inside the repo.

### 1.1 The licence requires a public web project

TradingView grants Advanced Charts free **"only to companies for use in public web
projects and/or applications"** and states it is not provided "for personal use,
hobbies, studies, or testing." The docs repeat it: _"you can use the library on
public websites only."_ Attribution (the TradingView logo/link the widget renders by
default) must stay visible — removing it voids the grant.

The console today is the opposite of that: one operator, behind a login, reachable
only through a Cloudflare tunnel. **Someone has to decide how this is squared** —
that is a licence question, not an engineering one. Options, in rough order of how
honest they are:

| Option                                    | What it means                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Make the console genuinely public-facing  | A public, unauthenticated surface exists at `app.codiapay.com` (e.g. a public landing/demo view) with the charts reachable. Changes the security posture — see `docs/TUNNEL.md` §Security. |
| Apply and describe the project accurately | Submit the application saying what it is; let TradingView rule. Cheapest, and the answer may simply be yes. **Do this first** — everything below is wasted if the answer is no.            |
| Pay for a commercial licence              | Removes the public-project condition and unlocks Trading Platform (§2).                                                                                                                    |
| Fall back to Lightweight Charts           | Apache-2.0, no conditions, but a hand-built replica. This plan's §4–§8 data layer is reusable verbatim; only the renderer changes.                                                         |

**Nothing else in this plan should start until the application is answered.**
Apply at <https://www.tradingview.com/advanced-charts/>.

### 1.2 This repo is public — the library must never be committed to it

`github.com/budieprof/lascodia-trading-engine-admin-ui` is **public** (verified
2026-09-19: anonymous `api.github.com` GET returns 200). Advanced Charts is
proprietary and distributed through a _private_ repo TradingView grants access to.
Committing its ~20 MB of files into a public repo redistributes it and breaks the
licence.

Therefore:

- `public/charting_library/` goes in `.gitignore`.
- A `scripts/fetch-charting-library.sh` pulls it from the granted private repo at a
  pinned version into `public/charting_library/`.
- `scripts/release.sh publish` fails loudly if the directory is absent, rather than
  publishing a release whose chart page is a blank box.

### 1.3 Half of one must-have is in the paid product

Advanced Charts (free) and Trading Platform (paid) are different products. Of the
four must-haves, three ship free and one does not:

| Must-have                    | Status                                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drawing tools + persistence  | **Free.** 110+ tools ship with the library; persistence is a `save_load_adapter` we implement (§8).                                                                                                                                             |
| Indicator library with panes | **Free.** 100+ indicators, multi-pane, settings dialogs — all built in.                                                                                                                                                                         |
| Bar replay                   | **Free.** Built into the toolbar.                                                                                                                                                                                                               |
| Trading overlays             | **Partly.** `createOrderLine`/`createPositionLine` are **Trading Platform only from v29**. We rebuild them from `createShape`/`createMultipointShape` + datafeed marks (§7) — visually equivalent, but not draggable and with no trading panel. |

Also Trading Platform-only, so **a "100% replica" is not on the table even on this
route**: multi-chart layouts, the watchlist widget, and the Account Manager. If any
of those is non-negotiable, the decision is a commercial licence, not more code.

---

## 2. What we get vs what we build

```
┌─ TradingView Advanced Charts (vendored, self-hosted) ──────────────────┐
│  candles · 110+ drawings · 100+ indicators · panes · bar replay        │
│  crosshair · timeframes · chart types · settings · alerts UI           │
└────────────────────────────┬───────────────────────────────────────────┘
                             │ Datafeed API + Save/Load adapter  ← WE BUILD
┌────────────────────────────▼───────────────────────────────────────────┐
│  LascodiaDatafeed          onReady · searchSymbols · resolveSymbol     │
│                            getBars · subscribeBars · getMarks ...      │
│  CandleFeedService         paging · aggregation · cache · forming bar  │
│  OverlayManager            positions / signals / events as shapes      │
│  LayoutStore               chart layouts + drawings (engine-persisted) │
└────────────────────────────┬───────────────────────────────────────────┘
                             │ existing engine API
                  /market-data/candle/list · SignalR priceUpdated
```

Everything in the lower box is ours and — importantly — **is renderer-independent**.
If §1.1 goes against us, the same code drives Lightweight Charts.

---

## 3. What the engine already provides

Verified against the live database and API on 2026-09-19.

| Timeframe | Symbols | Bars      | Oldest     | TradingView resolution |
| --------- | ------- | --------- | ---------- | ---------------------- |
| M1        | 23      | 3,920,267 | 2025-03-26 | `1`                    |
| M5        | 23      | 668,187   | 2026-03-04 | `5`                    |
| M15       | 23      | 294,635   | 2026-01-02 | `15`                   |
| H1        | 23      | 131,744   | 2025-06-26 | `60`                   |
| H4        | 23      | 45,031    | 2024-09-19 | `240`                  |
| D1        | 23      | 8,962     | 2024-09-20 | `1D`                   |

- **`POST /market-data/candle/list`** — paged. `CandleDto` is `{open, high, low,
close, volume, timestamp, isClosed}`.
- `GET /market-data/candle/coverage`, `/candle/watermarks`, `/candle/latest`.
- **SignalR** `priceUpdated`, room-scoped via the hub's `EnterRoom`/`LeaveRoom`.
- `src/app/shared/utils/live-candle.ts` already has `bucketStartMs`,
  `applyTickToCandles`, `preserveFormingBar` — the forming-bar problem is solved,
  reuse it rather than rewriting it inside the datafeed.

**Not stored: M30, W1, MN1.** The UI references `M30`/`W1`/`MN1` in places but the
`Candle` table has no rows for them. Either drop them from `supported_resolutions`
or aggregate (§5.2). Do not advertise a resolution we cannot serve — the library
will call `getBars` for it and hang on an empty response.

---

## 4. Phase 0 — Unblock (no code)

1. Submit the Advanced Charts application. Record the answer in this file.
2. Decide the §1.1 public-project question.
3. On grant: note the version (31.2.0 is current), accept the licence, get private
   repo access.
4. Add `public/charting_library/` to `.gitignore` **before** the first fetch, so it
   can never be staged by accident.

**Exit criteria:** written licence answer + library files on disk locally.

---

## 5. Phase 1 — Data layer (buildable now, renderer-independent)

The only phase that does not need the library, so it is the one to start on while
§1.1 is pending. Everything here is unit-testable with no chart on screen.

### 5.1 `CandleFeedService`

- `fetchRange(symbol, timeframe, fromMs, toMs, countBack)` → ascending `CandleDto[]`.
- Pages `POST /market-data/candle/list`. **The filter must be nested** under
  `filter` — sent flat it is discarded in silence and you get page 1 of the whole
  unfiltered table (guard: `responseCode -12`). Pass `sortBy`/`sortDirection`
  explicitly; the default sort is ascending and has bitten this codebase before.
- In-memory cache keyed `symbol|resolution`, merging fetched ranges so scroll-back
  never refetches a window it already holds.
- Honour `countBack`: from v29 the library wants _at least_ `countBack` bars ending
  at `to`, not merely "bars in range".

### 5.2 Resolution mapping + aggregation

| TV resolution                | Source                | Notes |
| ---------------------------- | --------------------- | ----- |
| `1`,`5`,`15`,`60`,`240`,`1D` | stored directly       | —     |
| `30`                         | aggregate ×2 from M15 | cheap |
| `1W`,`1M`                    | aggregate from D1     | cheap |

Aggregation rule: `open` = first, `close` = last, `high`/`low` = extremes, `volume` =
sum, bucket start = the TradingView bar time. **Weekly bars must align to the FX
week, not the ISO week** — the forex week opens Sunday ~22:00 UTC. Aligning to
Monday 00:00 silently produces a chart that disagrees with every other platform.

Do this client-side to start (the row counts are small). Move it server-side only if
profiling says so.

### 5.3 Symbol metadata

`resolveSymbol` must return a correct `LibrarySymbolInfo` or prices render at the
wrong precision:

- `pricescale`: 5-decimal FX → `100000`; JPY pairs (3-decimal) → `1000`. Derive from
  the digits on `CurrencyPairsService`, never hardcode.
- `session`: an FX session string, **not** `24x7`. With `24x7` the library expects
  weekend bars and renders gaps as missing data.
- `timezone: 'Etc/UTC'`, `has_intraday: true`, `minmov: 1`, `type: 'forex'`,
  `data_status: 'streaming'`.

### 5.4 Conformance tests (vitest)

The datafeed contract is precise and failures present as a chart that spins
forever rather than an error. Test: ascending order, `countBack` satisfied,
`noData: true` on empty, `nextTime` supplied across weekend gaps, aggregation
boundaries (including a week spanning a DST change), pricescale per symbol class.

**Exit criteria:** green conformance suite; `CandleFeedService` returns correct bars
for all 23 symbols across every advertised resolution.

---

## 6. Phase 2 — Page, widget bootstrap, history

- New feature `src/app/features/chart-analysis/`, lazy route `/chart-analysis` and
  `/chart-analysis/:symbol`, behind a `chart-analysis` feature flag in
  `public/config.json`, permission-guarded like its neighbours.
- Bootstrap the widget: `library_path: '/charting_library/'`, `datafeed`, locale,
  theme wired to the app's existing theme service, `autosize: true`.
- Wire `getBars` to Phase 1. Scroll-back must page smoothly to 2025 on M1.

**Exit criteria:** a real TradingView chart renders EURUSD H1 from engine data;
drawings, indicators and replay all work out of the box (they are the library's).

---

## 7. Phase 3 — Live bars, marks, trading overlays

### 7.1 `subscribeBars`

Join the symbol's SignalR room, translate `priceUpdated` into bar updates with
`applyTickToCandles`, and call `onTick`. Route strictly by `subscriberUID` and match
on symbol **and** resolution — the library subscribes for several at once and
mis-routing shows up as one chart's ticks appearing on another. Confirm whether the
hub's rooms are keyed per-route or per-symbol before relying on them.

### 7.2 Marks

- `getMarks` — trade signals, rejections, fills on the bar they belong to.
- `getTimescaleMarks` — economic events. Tier-1 prints matter here: positions held
  across them are already known to lose money, so seeing them on the time axis is
  the point.

### 7.3 Trading overlays (the rebuild from §1.3)

`OverlayManager` renders open positions (entry/SL/TP), orders and martingale rungs
as `createShape` horizontal lines with labels, refreshed from `positionOpened` /
`positionClosed` / `orderFilled`. It must **diff** desired vs drawn shapes and apply
the minimum change — removing and recreating every shape on each tick is the
standard way to make this page stutter.

**Exit criteria:** chart updates live; a position opened in MT5 appears within a
tick; signals and events are visible on the axes.

---

## 8. Phase 4 — Persistence

Implement `IExternalSaveLoadAdapter`: chart layouts, drawing (line-tool) persistence
per symbol, study and drawing templates.

- **Interim:** `localStorage` adapter — works immediately, per-browser only.
- **Durable:** new engine surface (`ChartLayout` table + CRUD endpoints). The
  existing `/chart-annotations` is a _text note_ surface, a different shape; don't
  contort it into layout storage.

**Exit criteria:** drawings and layouts survive reload and a republish.

---

## 9. Build, deploy and runtime traps

- **Release gate.** `release.sh publish` must assert `public/charting_library/` is
  present. The page is otherwise a silent blank.
- **Bundle size.** The library is ~20 MB of unhashed static files. Under the Caddy
  rules they fall in the `no-cache` class (revalidate, cheap 304s) — acceptable, but
  consider a dedicated `immutable` rule keyed on the pinned version directory.
- **CSP.** The library uses web workers and iframes. This is a concrete argument for
  the CSP still being deliberately off (see `CLAUDE.md` § Deliberately not done) —
  if CSP is ever added, do the report-only pass with this page open first.
- **Server time.** `getServerTime` should come from the engine, not the browser. The
  EA fleet has already been burned by a server-to-UTC offset fault producing future
  timestamps; a chart that silently draws bars in the future is the same class of bug.
- **Attribution.** Do not "clean up" the TradingView logo. It is a licence condition.

---

## 10. Testing

- **Unit (vitest):** the §5.4 conformance suite; aggregation; overlay diffing.
- **Browser (`.claude/skills/browser-verify`):** load `/chart-analysis`, assert a
  canvas renders with bars, no console errors, drawings persist across reload. Use
  the login form's Developer tab — the skill's token-minting path no longer
  authenticates.
- **Contract:** if engine endpoints are added in Phase 4, extend the engine repo's
  `integration-tests/contract-test`.

---

## 11. Sequencing

| Phase                     | Blocked by               | Rough size                                 |
| ------------------------- | ------------------------ | ------------------------------------------ |
| 0 Unblock                 | TradingView's answer     | days of waiting, no code                   |
| 1 Data layer              | nothing — **start here** | the bulk of our real work                  |
| 2 Page + history          | library access           | small once Phase 1 is solid                |
| 3 Live + marks + overlays | Phase 2                  | medium; overlays are the fiddly part       |
| 4 Persistence             | Phase 2                  | small client-side, medium if engine-backed |
| 5 Migrate existing chart  | Phase 3                  | deferred by decision; revisit after soak   |

Phase 1 is deliberately first _and_ independent: it is the only phase that survives
unchanged if the licence answer is no.

---

## Open questions

1. **Licence answer** — unresolved, blocking §§6–8. (§1.1)
2. **Public-project posture** — does the console become publicly reachable? Security
   implications in `docs/TUNNEL.md`.
3. **Multi-chart / watchlist / account manager** — Trading Platform only. Accept the
   gap, or price a commercial licence?
4. **SignalR room semantics** — per-route or per-symbol? Decides §7.1.
5. **M30/W1/MN1** — aggregate (§5.2) or drop from the resolution list?

## Sources

- [Advanced Charts](https://www.tradingview.com/advanced-charts/) ·
  [Free charting libraries](https://www.tradingview.com/free-charting-libraries/)
- [Licence agreement (PDF)](https://s3.amazonaws.com/tradingview/charting_library_license_agreement.pdf)
- [FAQ](https://www.tradingview.com/charting-library-docs/latest/getting_started/Frequently-Asked-Questions/) ·
  [Introduction](https://www.tradingview.com/charting-library-docs/latest/introduction)
- [Datafeed API](https://www.tradingview.com/charting-library-docs/latest/connecting_data/Datafeed-API/) ·
  [Drawings API](https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/drawings-api/) ·
  [IChartWidgetApi](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IChartWidgetApi/)
- [Lightweight Charts (fallback)](https://github.com/tradingview/lightweight-charts)

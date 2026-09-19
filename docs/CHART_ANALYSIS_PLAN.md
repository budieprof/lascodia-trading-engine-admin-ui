# Chart Analysis page — a hand-built TradingView replica

Plan for a dedicated chart-analysis workstation in the admin console, rendered on
**Lightweight Charts v5** (Apache-2.0, TradingView's own engine), fed by the
engine's market data and overlaid with this system's trading state.

## Decision log

**2026-09-19 — Advanced Charts rejected, Lightweight Charts + hand-built replica
adopted.** The console is a private, login-gated, single-operator application and
will stay that way. TradingView grants Advanced Charts only "to companies for use
in public web projects" and not for personal or internal use, so the real library
is not licensable here at any effort level (§1.1 keeps the evidence).

The goal is unchanged: **replicate TradingView's charting functionality**. It is
now built rather than embedded. That means we own the parts Advanced Charts would
have given us free — the drawing toolbar, the indicator library, bar replay, the
chrome — and it also means none of the §1.3 paid-tier gaps apply: order and
position lines, multi-chart layouts and the watchlist are ours to build, not
features withheld behind a commercial licence.

Sections §1.1–§1.3 are kept as the record of why, and because §1.1 is the section
to reread if anyone proposes embedding the real library again. **§1.2 no longer
applies** — nothing proprietary is vendored, so there is nothing to keep out of
this public repo. The §5 data layer was built renderer-independent precisely so
it survived this decision; it did, unchanged.

Scope is tracked in §12, which replaces the old §11 sequencing.

**2026-09-19 — the embedded ECharts plot stays on ECharts.** Migrating
`shared/components/trading-chart` onto this engine was considered and rejected
on measurement, not taste:

- It removes **no dependency**. ECharts is imported by 61 files for gauges,
  heatmaps, scatter and bar charts — none of which Lightweight Charts, a
  financial time-series library, can draw. The bundle saving is zero.
- The coupled surface is ~790 lines, not the ~145 that merely mention
  `echarts`. About 230 of those are the draggable SL/TP handles, and dragging
  one queues an EA command that moves a **real stop-loss broker-side**.

Paying that risk for cosmetic consistency on one panel is a bad trade. What the
migration was actually _for_ — reaching the drawing tools and studies from a
position or a recommendation — is served by a deep link instead: the toolbar's
**Full Chart ↗** anchor (`shared/components/trading-chart/chart-analysis-link.ts`)
carries the symbol and timeframe into `/chart-analysis/:symbol?tf=`. Reopen this
only if ECharts is being dropped app-wide, which is a different project.

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

**Resolved 2026-09-19: the console stays private, so this route is closed.** The
table above is kept because it is the decision, not a to-do — if anyone proposes
embedding the real library again, the answer is here. Apply at
<https://www.tradingview.com/advanced-charts/> only if the console's posture
changes.

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

## 2. The architecture we actually build

```
┌─ Lightweight Charts v5 (Apache-2.0, npm) ──────────────────────────────┐
│  canvas renderer · candle/bar/line/area/baseline series · panes        │
│  crosshair · price + time scales · primitives (our drawing surface)    │
└────────────────────────────▲───────────────────────────────────────────┘
                             │ everything below is OURS
┌────────────────────────────┴───────────────────────────────────────────┐
│  ChartHostComponent    chart lifecycle · styles · panes · legend feed  │
│  indicators/registry   the study catalogue — one entry per indicator   │
│  indicators/math       pure, tested indicator maths                    │
│  CandleFeedService     paging · aggregation · cache · countBack        │
│  (to build) drawings · replay · overlays · layouts · watchlist         │
└────────────────────────────┬───────────────────────────────────────────┘
                             │ existing engine API
                  /market-data/candle/list · SignalR priceUpdated
```

The split that matters: the renderer draws, and **every decision about what to
draw is ours**. That is what made the §5 data layer survive the switch away from
Advanced Charts untouched, and it is why adding an indicator is a registry entry
rather than a change to the chart component.

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

## 8. Phase 4 — Persistence ✅ SHIPPED

Two tiers, both live:

- **Layouts and study templates** — `workspace/layout-store.service.ts`,
  `localStorage`. Per-browser is the right scope for a window arrangement.
- **Drawings** — engine-backed. `drawings/drawing-store.service.ts` keeps a
  `localStorage` cache for instant paint and syncs to the engine on a 900 ms
  debounce via `core/services/chart-drawings.service.ts`.

Engine side: `ChartDrawing` entity, `GetChartDrawings` query,
`ReplaceChartDrawings` command, `ChartDrawingController`. Two traps paid for:

- **Ownership key is a `string`, not a `long`.** `long.TryParse(UserId)`
  rejected every caller, because the dev login issues `dev-user-1`. Hence
  `OwnerKey` (migration `20260919160822_ChartDrawingOwnerKeyAsString`).
- **The unique index must be PARTIAL.** `(OwnerKey, ClientId)` unique across all
  rows breaks on delete → undo → delete, because the soft-deleted row still
  occupies the key. It is filtered on `"IsDeleted" = false`, so uniqueness holds
  among live rows only.

The existing `/chart-annotations` is a _text note_ surface, a different shape;
it was deliberately not contorted into drawing storage.

**Exit criteria met:** drawings survive reload, a republish, a different browser
and a different machine.

---

## 9. Build, deploy and runtime traps

The first two entries here used to concern vendoring `public/charting_library/`
and its logo attribution. Neither applies — nothing proprietary is vendored
(decision log). What remains:

- **CSP is ENFORCING** as of 2026-09-19, promoted only after a measured
  report-only pass: all 74 sidebar routes swept with the console captured, zero
  violations, plus drawing on the chart, adding a study, the canvas→PNG
  snapshot and the assistant bubble. `worker-src blob:` is required and is not
  in the `docker/nginx.conf` copy — this page and several ML pages create
  workers from blob URLs. To roll back, rename the header to
  `Content-Security-Policy-Report-Only` and `caddy reload`.
- **Pointer events must be captured, not bubbled.** Lightweight Charts stops
  them at its own canvas, so a bubble-phase listener never sees a click on the
  chart. `drawings/drawing-controller.ts` uses **capture phase** for this
  reason; moving it back silently kills every drawing tool.
- **Paged engine queries need an explicit sort.** The economic-events overlay
  showed 9–18 Sep while the API returned 5–20 Aug: an ascending default sort on
  a capped page returns the OLDEST window. Always send `sortBy` /
  `sortDirection`.
- **Candles page newest-first.** `datafeed/candle-feed.service.ts` exports
  `normaliseRows` as a pure function precisely because aggregation over
  reversed input silently inverts candles rather than failing.
- **Server time.** Bar times come from the engine, not the browser. The EA fleet
  has already been burned by a server-to-UTC offset fault producing future
  timestamps; a chart that silently draws bars in the future is the same class
  of bug.
- **Deploys are not live-reload.** Since 2026-09-19 source edits do not reach
  `:8080`; `./scripts/release.sh publish` builds, stamps, stages and atomically
  swaps a symlink. Verify with `release.sh status`, roll back with
  `release.sh rollback`.

---

## 10. Testing

- **Unit (vitest):** the §5.4 conformance suite; aggregation; overlay diffing.
- **Browser (`.claude/skills/browser-verify`):** load `/chart-analysis`, assert a
  canvas renders with bars, no console errors, drawings persist across reload. Use
  the login form's Developer tab — the skill's token-minting path no longer
  authenticates.
- **Cross-feature invariants:** where two features must agree but neither
  imports the other, the guard has to live in a module both can reach.
  `chart-analysis-link.spec.ts` is the worked example — it imports the embedded
  chart's timeframe pills and the datafeed's `SUPPORTED_RESOLUTIONS` and asserts
  every pill leads somewhere servable.
- **Contract:** Phase 4 added engine endpoints, so keep the engine repo's
  `integration-tests/contract-test` in step when `ChartDrawingController`
  changes shape.

Suite is at 526 vitest tests across 26 files.

---

## 12. Parity gap analysis — measured against Advanced Charts

Checked against TradingView's own docs (`ui_elements`, the `ChartStyle` enum,
the `DrawingToolIdentifier` type). Last measured 2026-09-19.

### 12.1 Chart styles — 18 of 18 ✅

Candle, HollowCandle, HeikinAshi, Bar, HLCBars, Line, LineWithMarkers,
Stepline, Area, HLCArea, Baseline, Column, Renko, Line Break, Kagi, Point &
Figure, **VolCandle, HiLo**.

The last two are the only ones with no built-in series behind them and live in
`chart/custom-series.ts` as `ICustomSeriesPaneView` implementations: `HiLo` is a
range bar with neither an open nor a close tick (a bar series minus the open
tick is HLCBars, a different style), and `VolCandle` scales each body's WIDTH by
volume, which no built-in series does. `VolCandle` measures share against the
max volume in the **visible** range, so zooming into a quiet stretch still shows
relative differences instead of a row of hairlines.

### 12.2 Drawing tools — 95 🟡

Lines, channels (parallel, flat, regression, disjoint angle), four pitchforks,
Gann box/fan/square, the full Fibonacci set (retracement, extension, channel,
time zones, circles, arcs, wedge, speed fan), Elliott impulse/correction/
triangle, harmonic patterns (ABCD, XABCD, three drives, head and shoulders,
triangle), shapes, annotations and the measurement/position tools.

The machinery is complete: hit-testing, handles, drag, resize, magnet, style
inspector, lock, clone, object tree, undo/redo, per-symbol+timeframe
persistence, and per-panel scoping for split layouts. Adding a tool is one
`TOOLS` entry plus a renderer case.

Persistence is **engine-backed** (§8), not just localStorage: drawings survive a
different browser and machine.

Against TradingView's ~110 the remainder is not analytical: images, emoji
stickers and the publish/idea-sharing tools, none of which mean anything in a
private console.

**This list was stale once already** — it named Fib spiral, cyclic/sine lines,
the Elliott combos and the cypher/5-point harmonics as missing long after they
shipped. Count from `TOOLS`, never from this paragraph.

### 12.3 Indicators — 71 🟡

Moving averages (SMA, EMA, WMA, SMMA, Hull, DEMA, TEMA, ALMA, VWMA, LinReg),
bands (Bollinger + %B + Bandwidth, Keltner, Donchian, Envelope, Standard Error),
Ichimoku, PSAR, SuperTrend, Alligator, Pivot Points, VWAP, and the
oscillator/volume set (RSI, MACD, PPO, Stochastic, Stoch RSI, Schaff Trend
Cycle, ATR, ADX, CCI, Williams %R, MFI, Momentum, ROC, TRIX, DPO, Aroon, KST,
Coppock, RVI, Ultimate, Awesome, Fisher, Choppiness, Vortex, Historical
Volatility, OBV, A/D, CMF, Chaikin Osc, Force Index, Elder Ray, BOP, EOM, PVT,
Mass Index, Volume Oscillator, NVI/PVI, Volume Profile).

Closes linearly through `indicators/registry.ts` — one entry each.

Two traps already paid for, both in `indicators/math.ts`: `sma`'s rolling sum
drifts, so Stoch RSI emitted −7.1e-15 until it was clamped after smoothing; and
standard-error bands must recompute the regression **inside** the band
calculation — measuring residuals against the regression endpoint gave 218 where
the fitted line gives 267 on a perfect ramp.

### 12.4 UI elements

| Advanced Charts element                   | Status                         |
| ----------------------------------------- | ------------------------------ |
| Symbol search · timeframes · chart styles | ✅                             |
| Indicators menu, studies legend, panes    | ✅                             |
| Legend (OHLC, change, study values)       | ✅                             |
| Drawing toolbar + object tree + inspector | ✅                             |
| Undo/redo · keyboard shortcuts · magnet   | ✅                             |
| Price scale: normal / log / percent       | ✅                             |
| Bar replay (step, scrub, play 1-30×)      | ✅                             |
| Marks on bars (trade signals)             | ✅                             |
| Timescale marks (economic events)         | ✅                             |
| Position / order lines                    | ✅ (§12.5 — paid tier in AC)   |
| Saved layouts + study templates           | ✅                             |
| Snapshots (chart image)                   | ✅                             |
| Context menu (right-click)                | ✅                             |
| Fullscreen                                | ✅                             |
| Timezone selector                         | ✅                             |
| Watchlist                                 | ✅                             |
| Multi-chart layout (1 / 2 / 4 / 6 / 8)    | ✅ (matches AC's 8)            |
| Alerts                                    | ✅ price alerts from the chart |
| Details · News panes                      | ✅ (News carries pair bias)    |
| Market status indicator                   | ✅ (legend: "market closed")   |

Two UI traps worth keeping: `[value]` on a `<select>` fed by `@for` does not
stick — all three split panels showed the same symbol until it moved to
`ngModel`; and the 50+ button tool rail has ~1700px of intrinsic height, which
drove the page to 1861px in a 950px viewport. `min-height: 0` + `overflow-y:
auto` did **not** fix that; the rail has to leave flow (`position: absolute`).

### 12.5 Beyond Advanced Charts ✅

Open positions with entry/SL/TP, **order lines, martingale rungs**,
trade-signal markers, and economic events on the time axis — none of which
Advanced Charts offers at any tier we could licence.

Timezone handling is the subtle one: drawings are stored in UTC, so the
selected offset is applied at projection and **inverted on click-read**. Skip
the inversion and every drawing slides when the operator changes timezone.

Economic-event marks must render at `zOrder: 'normal'` — `'bottom'` puts them
beneath the pane background, i.e. invisible.

### 12.6 Reaching the workspace from elsewhere ✅

`/chart-analysis/:symbol?tf=` is a deep link, and the embedded trading chart's
**Full Chart ↗** anchor uses it so an operator studying a position or an LLM
recommendation can get to the drawing tools without re-selecting the
instrument. The symbol and timeframe vocabularies differ between the two
surfaces; `shared/components/trading-chart/chart-analysis-link.ts` owns the
translation and its spec asserts every pill maps to a resolution the datafeed
can actually serve.

---

## 13. What is left

| Item                      | Why it is not done                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Images, stickers, "ideas" | TradingView's remaining ~15 tools are publishing and decoration, not analysis. No value in a private console. |
| ECharts migration         | **Rejected on measurement**, not deferred — see the decision log. Do not re-open.                             |

Everything else once listed here has shipped: 18/18 chart styles, 95 drawing
tools, 71 indicators, the 8-way split, order lines and martingale rungs,
engine-backed drawing persistence, and the Details and News panes.

### A warning about this section

Three separate entries here were **stale rather than pending** when checked on
2026-09-19: the drawing-tool gap list named tools that had shipped, the Details
and News panes were marked ❌ while both were built and rendering, and the
Renko/P&F sizing "open question" had already been answered by a `Box n ×ATR`
input sitting in the toolbar.

A plan document drifts behind the code silently, and a stale "what's left" is
worse than none — it sends someone to build what exists. **Count from the source
before trusting any number here:**

```bash
# tools
node -e "const s=require('fs').readFileSync('src/app/features/chart-analysis/drawings/model.ts','utf8');
         const m=s.match(/export const TOOLS[\s\S]*?\n\];/)[0];
         console.log((m.match(/kind:\s*'/g)||[]).length)"
# indicators
grep -cE "^    id: '" src/app/features/chart-analysis/indicators/registry.ts
```

## Open questions

None outstanding.

## Resolved questions

- **SignalR room semantics** — settled as **per-symbol**
  (`SubscribePrice`/`UnsubscribePrice`) rather than the per-route
  `EnterRoom`/`LeaveRoom` pattern. The live bar used to filter client-side on
  the tick's symbol, which worked but over-subscribed the hub.
- **Renko / P&F box sizing** — an operator input, not a fixed ATR derivation.
  The `Box n ×ATR` control appears in the toolbar for price-based styles only.

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

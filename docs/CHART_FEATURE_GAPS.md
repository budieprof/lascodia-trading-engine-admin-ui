# Chart Analysis — feature gaps vs TradingView

Measured 2026-10-01 against TradingView's **Indicators, metrics, and strategies**
dialog (Indicators · Strategies · Profiles · Patterns · Options; My scripts ·
Technicals · Fundamentals · Community). Scope: `/chart-analysis/:symbol`.
Companion to [CHART_ANALYSIS_PLAN.md](CHART_ANALYSIS_PLAN.md) §12–13 (styles,
drawing tools, UI chrome — already at parity).

## Status — shipped 2026-10-01

| Gap | Where it lives | Status |
| --- | --- | --- |
| Dialog: search across all tabs, tabs, categories, favourites, descriptions | `dialog/` | ✅ |
| One study namespace (indicator / `profile:` / `candle:` / `chartpattern:` / `fund:`) so layouts, templates and the studies bar handle all | `studies.ts` | ✅ |
| Select + symbol study inputs in the studies bar | page | ✅ |
| 38 more built-ins (111 total): MA ribbon/cross, KAMA, VIDYA, T3, ZLEMA, LSMA, ADR, Chop Zone, BB Trend, Ulcer, Chandelier, Klinger, Chaikin Vol, PO, DMI, RCI, Woodies CCI, SMI, Volume, VWAP bands, anchored VWAP, up/down volume, CVD (est.), auto Fib retr./ext., auto pitchfork, auto trendlines, pivots H/L, pivots standard (6 types × D/W/M), LinReg channel, sessions | `indicators/` | ✅ |
| Multi-symbol: correlation, relative strength, spread, ratio, compare % (compare bars fetched per symbol) | `indicators/`, page | ✅ |
| Strategies on chart (engine strategies by id, 6 built-in examples, My scripts), entry/exit markers, Strategy Tester (overview + equity, performance summary, trade list, inputs + re-run) | `scripts/` | ✅ |
| Pine indicators on chart (overlay or own pane; plots, shapes, labels, lines, boxes via `shared/pine-chart`) | `scripts/` | ✅ |
| Pine editor dock (compile + diagnostics, save to My scripts, add to chart) | `scripts/` | ✅ — My scripts are browser-local (engine has no store for stand-alone indicator scripts) |
| 39 candlestick patterns + "All", SMA50 trend filter | `patterns/` | ✅ |
| 23 chart patterns + "All" (double top/bottom, H&S, triangles, rectangle, flags, pennants, wedges, cup & handle, Elliott impulse, ABCD/Gartley/Bat/Butterfly/Crab/Cypher) | `patterns/` | ✅ |
| Profiles: visible range, session, periodic, fixed range, auto-anchored VP; TPO | `profiles/` | ✅ (tick volume) |
| FX fundamentals panes: rate differential, swap/carry per lot, news pressure (base − quote), economic surprise index | `panels/` + engine `GET /fx-fundamentals/{carry,surprise-index}` | ✅ |
| Details pane: performance tiles, technicals gauge, seasonals | `panels/` | ✅ |

## Not done, by decision

| Item | Why |
| --- | --- |
| COT positioning | Engine has the table + ingest endpoint but 0 rows — listed in the dialog as unavailable, nothing fabricated. |
| Options tab | No FX options feed. |
| Community / Marketplace / Purchased | Meaningless in a private console. |
| Day-of-week / time-range background shading | Needs a background-band plot kind the indicator registry does not have. |
| True CVD | No aggressor tape; CVD is built from estimated delta and labelled "(est.)". |
| Quick-trade Buy/Sell in the legend | Execution goes through the engine's signal pipeline, not the chart. |

## Traps found while building

- **External series must be sampled onto the chart's bars.** Every distinct time
  a series carries becomes a slot on the shared time axis; the news roll-up
  cadence wedged thousands of slots between hourly bars and squashed the chart.
- **Overlay line series need the symbol's `priceFormat`.** Without it the
  shared price axis drops to the library's 2 decimals (EURUSD 1.14).
- **The price series is replaced only on a style change** (since 2026-10-09,
  CC-I1; it used to be rebuilt on every bar update). Ticks reach every series
  as `update()` on the tail, `setData` only on a rebuild (series, style, zone,
  theme, box, history prepend) or a deep change. Anything attached to the price
  series (event marks, patterns, Pine layers, other features' primitives via
  `attachPricePrimitive`) is attached in `attachToPriceSeries`, which runs for
  every new price series — not only when its own input changes.
- **`timeScale().logicalToCoordinate` answers whole indexes only.** Lightweight
  Charts 5.2 returns 0 for a fractional logical index, so anything placed
  between bars (an event at 13:30 on 1h, a session break) needs `xAtLogical`
  (`chart/time-x.ts`): the whole index's x plus the fraction of a bar.
- **The first time-axis label is clipped at the left edge by the library.**
  Labels are drawn centred on their tick; Lightweight Charts slides an edge
  label inside the pane only with `fixLeftEdge`, which would stop scroll-back.
  The stray "0" at the bottom-left is the tail of such a label (CC-25), not an
  overlay.

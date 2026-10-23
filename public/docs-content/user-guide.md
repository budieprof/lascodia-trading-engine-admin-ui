# User guide

The chart (`/chart-analysis`, or `/chart-analysis/EURUSD`) is where most work happens: prices, the order book, your
orders and positions, scripts, alerts and bar replay. Open it from **Market Data**, a **Watchlist** tile, or the address.

## Prices on the chart

- **Candles and quotes are BID prices.** A buy fills at the ask; the spread is shown separately. Bar replay's paper
  trades follow the same rule (buys at bid + the bar's recorded spread).
- **Where the data comes from.** Candles, ticks and books come from the platform's designated broker sources. Several
  sources can be compared or combined: the order-flow menu's source picker and the **Multibook** rail panel show each
  source and a *consolidated* book (sizes in base-currency units, each level's share per source).
- **CME futures depth** (when your organisation is entitled to it) is drawn in *spot* terms: inverted for 6J / 6C / 6S
  and minus the futures-spot basis of each minute. Legends say "basis-adjusted" — or "not basis-adjusted" when no basis
  is known.
- **Not entitled.** A feed your organisation has no licence for shows as *not entitled*, never as a permission error.

## The order book ladder (DOM)

The **Ladder** side panel is a fixed price grid around the market (press **C** or the button to re-centre):

| Column | What it shows |
|---|---|
| Bid / Ask size | The broker book's size at that price — streamed live, or a 1.5-second polled snapshot (the panel says which). |
| My orders | Your working orders and pending manual signals at their prices. |
| Ticks | How many quotes touched that price this session (MT5 FX feeds carry no traded volume, so this is a tick count). |

**Trading from the ladder** uses the manual-signal path only. A click in the bid column places a buy limit (Shift: a
sell stop), in the ask column a sell limit (Shift: a buy stop), with the ticket's default brackets (stop 1.5 × ATR,
target 2R). The engine previews it — lots from your risk profile, money at risk, every gate — in a confirmation
dialog. **One-click trading** is an explicit opt-in for one account and one symbol, shown as ARMED, forgotten on reload.
Drag a working order to move it; × cancels it. **OCO** mode takes two clicks (one buy and one sell leg) and sends them
as one pair.

## The order ticket

**Buy / Sell** on the chart opens the ticket for ONE account: at market or at a price, with a stop and a target you can
also drag on the chart. Every change asks the engine for a dry run: lots, risk and reward in money, spread, swap,
exposure after the trade, and each check the live path runs. **Paper is the default**; Live needs a second click that
names the account and the size. What you submit is a manual *signal* — the engine judges it again (Tier 1 and Tier 2)
like any other.

## Bar replay

**Replay** starts at a clicked bar or a date. Step or play forward (Shift+→ ← ↓); intrabar steps load from 1-minute
data. Scripts run to the last *closed* bar — nothing past the replay head is ever drawn or read. Replay trades are
browser-only paper trades; replay never calls an order path.

## Alerts

- **Price and drawing alerts** fire on a *crossing* of the level (bid by default) — "crosses above", "crosses below",
  either, or a channel. The level starts beyond the live price on the chosen side, and a level the price has already
  reached is refused, so an alert never fires the moment it is made. They are evaluated tick by tick on the engine.
- **Script alerts**: the bell on a chart script's chip (a saved "My scripts" script) creates an alert on the script's
  `alert()` / `alertcondition()` calls. The alert manager's **Script alerts** tab lists, re-arms and pauses them.
- **Where they go**: the in-app bell, and the organisation's own channels (e-mail, Telegram, signed webhook) set up in
  **Organisation → Alert channels**.

## Scripts (Pine)

Indicators and strategies are Pine v6 scripts, authored in the dock's **Pine Editor**. On the live chart an indicator
runs *warm*: only new candles are executed, values on the forming bar are faded until the bar closes, and a plot that
changed on an already-closed bar is flagged **Repaints**. The **Strategy Tester** shows a script strategy's report.
Quantities are TradingView units (100 000 = one EURUSD lot); broker positions are in lots — the screens say which.

## Layouts and preferences

Your chart layouts (charts, studies, scripts, drawings) and preferences are saved to the engine, so the chart opens as
you left it on any browser. They are stored per person and per organisation.

## What the numbers mean

- **Backtest metrics**: *Total return* and *Max drawdown* are percentages; *Win rate* is a fraction.
- **"Real" in the account picker** means *not engine-paper*; it does not mean a broker Real account.

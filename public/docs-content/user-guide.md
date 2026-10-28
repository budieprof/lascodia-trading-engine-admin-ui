# Using the chart

> [!SUMMARY]
> The chart is where you watch prices, read the order book, set alerts and test ideas. It works like the trading charts you may know from other websites.
> This guide walks round the screen one part at a time: picking a symbol, reading candles, adding indicators and drawings, the price ladder, alerts, bar replay and Pine scripts. Placing trades has its own guide, [Placing trades](/docs/trading-guide).

```flow
Pick a symbol | What you want to look at | search
Pick a timeframe | How much time each candle covers | clock
Add tools | Indicators, drawings, scripts | chart-line
Read the book | The ladder and the multibook | layers
Get told | Alerts on a price, a drawing or a script | bell
Practise | Replay the past bar by bar | circle-play
@caption The usual path round the chart. You can do these in any order.
```

## Find your way round the screen

Open the chart from **Market Data** in the sidebar, from a watchlist tile, or by typing an address such as `/chart-analysis/EURUSD`. EURUSD is the euro priced in US dollars.

![The chart page: ((1)) the top toolbar, ((2)) drawing tools, ((3)) your watchlist and the symbol's details, ((4)) the panel buttons, ((5)) the bottom bar](chart-overview "/chart-analysis/EURUSD")

| Part | What it is for |
| --- | --- |
| **Top toolbar** ((1)) | Symbol, timeframe, chart type, indicators, alerts, the order ticket, replay and saved layouts. |
| **Drawing tools** ((2)) | Lines, channels, Fibonacci, shapes, text and measuring tools you draw on the chart. |
| **Watchlist and details** ((3)) | The symbols you follow, and today's prices for the one on the chart. |
| **Panel buttons** ((4)) | Side panels: details, news, calendar, notes, the order book, the ladder, the multibook, your account and alerts. |
| **Bottom bar** ((5)) | Quick date ranges (1D, 5D, 1M …), the **Pine Editor**, the **Strategy Tester**, the clock, and the % / log / auto scale switches. |

![The toolbar's action buttons: ((1)) set a price alert, ((2)) open the order ticket, ((3)) replay past candles, ((4)) your saved layouts](chart-toolbar-actions "/chart-analysis/EURUSD")

> [!TIP]
> Hover over any button to see what it does. Every button on the chart has a short description.

## Pick a symbol and a timeframe

A **symbol** is the short name of what you are looking at, such as EURUSD or GBPUSD. A **timeframe** is how much time each candle covers. `1h` means each candle is one hour.

![The left of the toolbar: ((1)) the symbol, ((2)) the timeframe, ((3)) the chart type, ((4)) indicators](chart-toolbar "/chart-analysis/EURUSD")

1. Click the symbol name ((1)) and start typing. Press [[Enter]] to open the first match.

   ![Symbol search: ((1)) type part of the name, ((2)) narrow the list to one kind of market](chart-symbol-search "/chart-analysis/EURUSD")

2. Click the timeframe ((2)) to choose another one, from 1 minute up to days, weeks and months.
3. For a timeframe that is not listed, type it in the box at the top of the menu, for example `45`, `3h` or `2D`, and press [[Enter]].
4. Click the star next to a timeframe to keep it on the toolbar, one click away.

   ![The timeframe menu: ((1)) type any timeframe, ((2)) star one to pin it to the toolbar](chart-intervals "/chart-analysis/EURUSD")

5. Click the chart type ((3)) to switch between candles, bars, lines and other styles.

> [!SUCCESS]
> The chart redraws for the new symbol or timeframe, and the address in your browser changes to match. You can bookmark it or send it to a colleague.

## Read the candles

Each candle shows what the price did during one period of time.

```stack
High | The thin line at the top: the highest price in the period | trending-up
-> then the body
Open and close | The thick part. Green: the price closed higher than it opened. Red: it closed lower. | chart-candlestick
-> then the lower line
Low | The thin line at the bottom: the lowest price in the period | trending-down
@caption One candle, read from the top down.
```

> [!NOTE] The chart shows the bid price
> Candles and the live price on the chart are **bid** prices: the price you can sell at. A buy fills at the **ask**, which is a little higher. The gap between the two is the **spread**, shown separately. See [Words explained](/docs/glossary#bid-and-ask).

- The newest candle is still forming. It keeps changing until its time is up.
- The label on the right edge marks the latest price.
- When the market is shut (for example at the weekend), the chart says **market closed** next to the symbol.

**Where the prices come from.** Candles, ticks and order books come from the platform's chosen broker sources. If your organisation is not licensed for a feed, the chart says *not entitled* rather than showing an error.

## The watchlist and symbol details

The **watchlist** is your list of symbols to keep an eye on. It shows each symbol's latest price and how much it has moved today.

![The watchlist: ((1)) add a symbol, ((2)) click a row to open it on the chart, ((3)) the details of the symbol on the chart](chart-watchlist "/chart-analysis/EURUSD")

1. Click {{+}} ((1)) to add a symbol to the list.
2. Click any row ((2)) to switch the chart to that symbol.
3. Right-click a row to flag it, move it to another section, or remove it.
4. Use the **⋯** menu to create, copy, rename or delete lists, add sections, or reset the columns.

| Column | Meaning |
| --- | --- |
| **Last** | The latest price. |
| **Chg** | How far the price has moved since the trading day began. |
| **Chg%** | The same move as a percentage. |

The details card ((3)) shows the latest price, today's change, and today's **Open**, **Prev close**, **Day high** and **Day low**. For forex, the trading day starts at 17:00 New York time.

> [!TIP]
> The **Flagged** list collects every symbol you have flagged in any of your lists, so you can find them all in one place.

## Add indicators and studies

An **indicator** (also called a study) is a calculation drawn on the chart. A moving average, for example, smooths out the price so you can see the trend.

1. Click **Indicators** on the toolbar.
2. Type a name in the search box ((1)), or browse the tabs ((2)): **Indicators**, **Strategies**, **Profiles**, **Patterns** and **Fundamentals**.
3. Click a name to add it. Some draw on top of the candles (*overlay*); others open in their own pane below (*pane*).

![Indicators, metrics and strategies: ((1)) search, ((2)) the tabs, with the number of items in each](chart-indicators "/chart-analysis/EURUSD")

Each study you add appears in the list under the chart, with small buttons beside it.

![The studies under the chart, with buttons for ((1)) settings, ((2)) the script's source code, ((3)) an alert on the script](chart-studies-legend "/chart-analysis/EURUSD")

- The eye shows or hides a study. The **×** removes it.
- Settings ((1)) changes its inputs, colours and lines.
- To keep a set of studies for later, open the layout menu and choose **Save studies as template…**.

## Draw on the chart

Drawings mark up the chart: a trend line along the lows, a box round a range, a note.

![The drawing tools: ((1)) the cursor, ((2)) magnet mode, ((3)) remove every drawing on this chart](chart-drawing-tools "/chart-analysis/EURUSD")

1. Pick a tool from the column on the left. Small arrows open groups such as **Lines**, **Channels**, **Fibonacci**, **Patterns**, **Shapes & Brushes** and **Text & Annotations**.
2. Click on the chart to place the first point, then click again for the next one.
3. Press [[Esc]] or click the cursor ((1)) to stop drawing.

- **Magnet mode** ((2)) snaps your clicks to the nearest open, high, low or close.
- The lock and eye buttons lock or hide all drawings. The bin ((3)) removes every drawing on this chart.
- Click a drawing to select it. A small toolbar appears for its colour, settings and an alert.
- Your drawings are saved to your account. If the connection drops, the toolbar says *local only* and sends them when it is back.

## The price ladder (order book)

The **order book** lists the prices people are waiting to buy and sell at, and how much is waiting at each one. The **ladder** shows it as a fixed price grid round the market price. Open it with the **Price ladder (DOM): trade from the book** button in the panel strip. DOM stands for *depth of market*, another name for the order book.

![The price ladder: ((1)) where the book comes from, ((2)) the account it trades for, ((3)) paper or live, ((4)) the columns](chart-ladder "/chart-analysis/EURUSD")

The note at the top ((1)) tells you where the sizes come from: a **live book** that updates on every change, or a snapshot **polled every 1.5 s** when the live stream is not available. Either way it is one broker's book, not the whole market.

| Column ((4)) | What it shows |
| --- | --- |
| **Buy** / **Sell** | Your own working orders and waiting manual trades at that price. |
| **Bid** | How much is waiting to buy at that price. The best bid is highlighted. |
| **Price** | The price of the row. Your open position's average price is tagged **L** (long) or **S** (short) with its size. |
| **Ask** | How much is waiting to sell at that price. The best ask is highlighted. |
| **Ticks** | How many price updates touched that row this session. MetaTrader 5 forex feeds carry no traded volume, so this counts ticks, not money traded. |

- Press [[C]] or the ⌖ button to put the market back in the middle. With **auto** ticked, the ladder re-centres by itself.
- The **×** box sets how many price steps each row covers.
- A size like `2.2M` means 2.2 million units of the first currency in the pair.

You can also place, move and cancel orders straight from the ladder. [Placing trades](/docs/trading-guide#trade-from-the-ladder) explains it step by step.

## Compare sources with the multibook

Some symbols have prices from more than one source, for example several brokers. The **Multibook** panel puts them together, so you can see when one source is out of line.

![The multibook: the sources you may see, the combined book, the dispersion strip and the source health table](chart-multibook "/chart-analysis/EURUSD")

- Tick or untick a source to include it in the combined book. Sizes are in units of the first currency, added up across sources.
- **Dispersion** shows how far each source's middle price is from the middle of the others, over the last 5 minutes.
- **Source health** lists each source's **State**, **Age** (how old its newest price is), **Lag**, **Dev** (how far it is from the others) and **Spread**.

> [!NOTE] Futures depth
> When your organisation is licensed for CME futures depth, it is drawn in spot terms: turned upside down for 6J, 6C and 6S, and shifted by each minute's gap between the futures and the spot price. The legend says *basis-adjusted*, or *not basis-adjusted* when that gap is not known.

## Set price alerts

An **alert** tells you when the price reaches a level you care about, so you do not have to watch the screen. Lascodia checks alerts on every price change, even when your browser is closed.

1. Click the bell, **Create price alert**, on the toolbar.
2. Under **When** ((1)), choose **Crosses above**, **Crosses below**, **Crosses (either way)**, **Enters channel** or **Exits channel**.
3. Under **Price** ((2)), choose **Bid** (the price the chart shows), **Ask** (where a buy fills) or **Mid** (halfway between).
4. Type the **Level** ((3)). It starts just beyond today's price, on the side you chose.
5. Under **Trigger** ((4)), choose how often it may fire.
6. Under **Notify by** ((5)), tick where the message should go.
7. Optional: set when it **Expires**, give it a **Name**, and write your own **Message**.
8. Click {{Create}}.

![The price alert form: ((1)) the direction, ((2)) which price, ((3)) the level, ((4)) how often, ((5)) where to send it](chart-alert "/chart-analysis/EURUSD")

| Trigger | When it fires |
| --- | --- |
| **Only once** | The first time, then it stops. |
| **Once per bar** | At most once in each candle of this timeframe. |
| **Once per bar close** | When a candle closes on the other side of the level. |
| **Every time** | Every crossing. It pauses itself if it fires more than 15 times in 3 minutes. |

> [!NOTE] Why an alert never fires straight away
> An alert fires when the price **crosses** the level. A level the price has already reached is refused, so a new alert never goes off the moment you make it.

**Other ways to make an alert:**

- Right-click the chart and choose **Add alert at** a price.
- Select a drawing and click **Add alert** on its toolbar. The level follows the drawing, candle by candle.
- Click the bell on a saved script in the studies list (see [Pine scripts](#pine-scripts)). It fires when the script itself calls for an alert.

### Where alerts are delivered

```flow
Alert fires | Lascodia checks every price change | bell
In app | The bell at the top of the console | monitor
Your organisation's channels | E-mail, Telegram or a signed webhook | send
@caption In app always works. E-mail, Telegram and webhooks use the channels an admin sets up in Organisation → Alert channels.
```

### Manage your alerts

Open the **Alerts** panel with the bell at the bottom of the panel strip.

![The alerts panel: ((1)) the Script alerts tab, ((2)) make a new alert](chart-alert-manager "/chart-analysis/EURUSD")

- **List** shows the alerts on this symbol, or on **All symbols**. Each one has **Pause**, **Resume**, **Edit**, **Clone** and **Delete**.
- **Log** shows when alerts fired.
- **Script alerts** ((1)) lists alerts on scripts. Re-arm or pause them here.

## Practise with bar replay

**Bar replay** hides the future so you can replay the past candle by candle, as if it were happening now. It is a safe way to practise reading the chart.

1. Click **Replay** on the toolbar.
2. Click a candle on the chart to start there. Or click {{Select bar}} ((1)), or pick a date and time in **Start at**.
3. Click play ((2)) to run, or step one candle at a time ((3)).
4. Choose a **Speed**. Tick **1m steps** to move inside a candle using 1-minute data.
5. Click {{Exit}} when you are done.

![The replay bar: ((1)) choose the start, ((2)) play or pause, ((3)) step forward, ((4)) practise buying and selling](chart-replay "/chart-analysis/EURUSD")

| Keys | Action |
| --- | --- |
| [[Shift]] + [[→]] | Forward one step |
| [[Shift]] + [[←]] | Back one step |
| [[Shift]] + [[↓]] | Play or pause |

**Practise trades.** The **Paper** row ((4)) lets you buy and sell at the replay price, with a stop and a target in pips. Buys fill at the bid plus that candle's recorded spread, like a real buy. These trades live only in this browser tab and end when you leave replay. Nothing is sent to the engine or a broker.

> [!NOTE]
> Scripts run only up to the last closed candle before the replay point. Nothing after it is drawn or read, so replay never shows you the future by accident.

## Pine scripts

**Pine** is a small programming language for indicators and strategies, made popular by TradingView. Lascodia runs Pine version 6 scripts on its own servers.

1. Click **Pine Editor** in the bottom bar.
2. Write or paste your script. To bring in an open-source TradingView script, click {{Import…}}.
3. Click {{Compile}} ((1)) to check it. Mistakes are listed with their line numbers.
4. Click {{Save}} ((2)) to keep it in **My scripts**.
5. Click {{Add to chart}}, or {{Update on chart}} ((3)) when it is already there.

![The Pine Editor: ((1)) check the script, ((2)) save it to My scripts, ((3)) put it on the chart](chart-pine-editor "/chart-analysis/EURUSD")

- {{History}} lists every saved version, compares two of them, and restores an old one.
- {{Share}} lets everyone in your organisation run and copy the script. Only you can change it.
- Work you have not saved is kept in this browser and offered back next time.

**Live scripts.** On the live chart, a script only works out the newest candles. Values on the candle still forming are faded until it closes. If a line changes on a candle that has already closed, the script's chip says **Repaints**. That warns you the script can rewrite the past, so its history may look better than it would have in real time.

### Test a strategy

A **strategy** script decides when to buy and sell. The **Strategy Tester** shows how it would have done on this chart.

![The Strategy Tester before a strategy is on the chart: ((1)) add one](chart-strategy-tester "/chart-analysis/EURUSD")

1. Click **Strategy Tester** in the bottom bar.
2. Click {{Add a strategy}} ((1)) and pick one, or put your own strategy script on the chart.
3. Read the tabs: **Report** (the summary), **List of trades**, **Inputs**, and **Properties** (starting money, order size and costs).

> [!WARNING] Results on the past are not a promise
> A good test on past prices does not mean a strategy will make money in future. Costs, slippage and changing markets all matter.

## Save your layouts

Your chart layout (charts, studies, scripts and drawings) and your preferences are saved to your account by themselves. The chart opens as you left it, on any computer. Layouts are kept per person and per organisation.

![The layout menu: ((1)) start a new layout, ((2)) save your studies as a template](chart-layouts "/chart-analysis/EURUSD")

1. Click the layout name on the toolbar. It says **Unnamed** until you name it.
2. Choose **New layout…**, **Rename…** or **Make a copy…**, or click a layout in the list to open it.
3. The word next to the name says **Saved** once your changes are stored.

> [!TIP]
> The grid button next to the layout name splits the screen into two or more charts. Charts in the same link group follow each other when you change the symbol.

## What the numbers mean

| You see | It means |
| --- | --- |
| A small raised last digit, as in 1.1119⁸ | A tenth of a pip. See [pip](/docs/glossary#pip). |
| **Total return** and **Max drawdown** in a backtest | Percentages. |
| **Win rate** in a backtest | A fraction: 0.55 means 55 trades out of 100 won. |
| Quantities in a Pine strategy | TradingView units: 100 000 is one standard EURUSD lot. Broker positions are shown in lots. The screen says which. |
| **All accounts (5 · 1 real, 4 demo)** in the account picker | How many of your connected accounts are real-money and how many are demo. Paper accounts are counted apart. |

## If something goes wrong

?? The chart is empty or says there are no candles.
   1. Check the symbol is right. Try a well-known one such as EURUSD.
   2. Try another timeframe.
   3. If it says **market closed**, the market is shut (for example at the weekend). Older candles still show.

?? The ladder is empty.
   - Read the note at the top. If it says *not entitled*, your organisation is not licensed for that feed. Ask an administrator.
   - Some sources only send prices, not sizes. Then rows show prices with no sizes.

?? My alert did not fire.
   - Check it in the **Alerts** panel. A paused or expired alert does not fire.
   - The alert fires on a **crossing**. If the price touched the level but did not cross it, nothing happens.
   - For e-mail, Telegram or a webhook, check that an admin has set up the channel in **Organisation → Alert channels**. The in-app bell always works.

?? The toolbar says "local only" or "not saved".
   Your drawings are kept in this browser until the engine answers, then sent. If it stays that way, reload the page. Nothing is lost.

?? A script says "Repaints".
   The script changed a value on a candle that had already closed. It still runs, but treat its history with care.

```decide
Is the price on the chart live?
Yes: The latest-price label on the right moves, and the symbol details say Market open.
No: It says market closed. Wait for the market to open, or open a symbol that is trading now.
Not sure: Open the price ladder. Its note says whether it has a live book or a polled snapshot.
```

## Where to next

```cards
shopping-cart | Placing trades | Buy and sell from the chart, safely | /docs/trading-guide
book-open | Words explained | Pips, spread, bid and ask in plain words | /docs/glossary
rocket | Start here | The five steps to get going | /docs/getting-started
building | Running your organisation | Set up e-mail, Telegram and webhook alerts | /docs/admin-guide
```

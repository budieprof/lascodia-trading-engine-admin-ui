# Placing trades

> [!SUMMARY]
> You can buy and sell straight from the chart: with the order ticket, or by clicking prices on the ladder. Every trade starts as **paper** (pretend money), so you can practise without risk.
> Before anything is sent, Lascodia does a dry run. It shows the size, how much money you could lose and gain, and every safety check, with the reason when one fails. Futures, crypto and stocks use their own ticket.

```flow
Open the ticket | Trade on the chart toolbar | shopping-cart
Set the trade | Buy or sell, stop loss, take profit | target
Read the dry run | Size, risk, reward and checks | clipboard-check
Send it | Paper first; live needs a second click | send
Follow it | Orders and Positions pages | list-checks
@caption From idea to open trade. Nothing reaches your broker until you send a live order and it passes every check.
```

## Words you need first

Trading has its own words. These are the ones this guide uses. Each links to a longer explanation.

| Word | In one line |
| --- | --- |
| [Stop loss](/docs/glossary#stop-loss) | A price where your trade closes by itself if the market goes against you, so a loss cannot grow past what you planned. |
| [Take profit](/docs/glossary#take-profit) | A price where your trade closes by itself to bank the gain. |
| [Lot](/docs/glossary#lot) | The unit of trade size. One standard lot of EURUSD is 100 000 euros. |
| [Pip](/docs/glossary#pip) | A small, standard step in price. For EURUSD it is 0.0001. |
| [Spread](/docs/glossary#spread) | The gap between the buying price and the selling price. It is a cost you pay on every trade. |
| [Margin](/docs/glossary#margin) | Money your broker sets aside while a trade is open, as a deposit. |
| [Leverage](/docs/glossary#leverage) | Trading a bigger amount than the money you put down. It makes gains and losses bigger. |
| [ATR](/docs/glossary#atr) | How far the price usually moves in one candle. Lascodia uses it to judge whether a stop is too tight. |
| [R](/docs/glossary#r-multiple) | The money you risk on a trade. A target of 2R would win twice what you risk. |

## Paper first, live later

**Paper** trades are pretend trades. Lascodia works out what would have happened at the real market price, including the usual costs, but nothing is sent to your broker. **Live** trades are real orders at your broker.

| | Paper | Live |
| --- | --- | --- |
| Is it the default? | Yes | No, you must choose it |
| Reaches your broker? | No, never | Yes, through your MetaTrader 5 terminal |
| Uses real money? | No | On a real-money account, yes |
| Order at a set price? | No, paper fills at market only | Yes |
| Extra confirmation? | No | Yes, a second click that names the account and the size |

> [!DANGER] Before you go live
> A live order on a real-money account trades your money. Check the account name, the size and the stop loss in the confirmation **every time**. If you are not sure, stay on paper.

> [!NOTE]
> Your platform may switch live tickets off completely, or allow them only on demo accounts. Live tickets on real-money accounts are off unless your platform team turns them on. Your organisation may also require a second person to approve large live orders.

## Open the order ticket

The order ticket is a small form on the chart for one trade on one account.

1. Open the chart for the symbol you want, for example EURUSD.
2. Click **Trade** on the toolbar ((1)).

![The Trade button on the chart toolbar ((1))](trade-open-ticket "/chart-analysis/EURUSD")

3. Choose the **Account** ((1)) the trade is for.
4. Click **Buy** or **Sell** ((2)). Each button shows the price you would get now: a buy fills at the ask, a sell at the bid.
5. Under **Entry** ((3)), keep **Market** to trade now, or choose **At price** and type the price you want. At price waits until the market reaches it, and works for live orders only.

![The order ticket: ((1)) the account, ((2)) buy or sell, ((3)) trade now or at a price](trade-ticket "/chart-analysis/EURUSD")

> [!TIP]
> The ticket picks the account for you when only one account is selected at the top of the console.

## Set your stop loss and take profit

Every manual trade needs a **stop loss**. The ticket refuses to send one without it.

1. Type the **Stop loss** price ((1)), or drag the red stop line on the chart.
2. Type the **Take profit** price ((2)), or drag the green target line. It is optional.
3. Check **Mode** ((3)): **Paper** or **Live**.

![The lower half of the ticket: ((1)) stop loss, ((2)) take profit, ((3)) paper or live, ((4)) send](trade-ticket-send "/chart-analysis/EURUSD")

- When the engine first checks the ticket, it fills in a stop 1.5 ATR away and a target at 2R, if you have not set them.
- Next to each box you see the distance in pips, and for the stop also in ATR.
- For a buy, the stop must be **below** the entry. For a sell, it must be **above** it.
- The stop must be at least **1 ATR** away from the entry (your platform may set a bigger minimum). A tighter stop is usually hit by ordinary price wobbles, so the ticket refuses it.

```stack
Take profit | Above the entry for a buy. The trade closes here with a gain. | trending-up
-> the price moves up to here
Entry | Where you buy | arrow-right
-> or down to here
Stop loss | Below the entry for a buy, at least 1 ATR away. The trade closes here with a small, planned loss. | shield
@caption A buy trade. For a sell, flip it: the stop above, the target below.
```

## Read the dry run

Each time you change the ticket, Lascodia asks the engine for a **dry run**: a test of the trade that sends nothing. It refreshes about every 10 seconds while the ticket is open, because prices move.

![A ticket after its dry run: ((1)) the numbers, ((2)) the checks, ((3)) the send button, ready because every check passed](trade-ticket-preview "/chart-analysis/EURUSD")

| Line | What it tells you |
| --- | --- |
| **Size** | How many lots, worked out from your account's risk settings. |
| **Risk** | How much money you lose if the stop loss is hit, and what share of your account that is. |
| **Reward** | How much you win if the take profit is hit, and how many R that is. |
| **Spread** | The current gap between buy and sell prices, in pips. |
| **Swap / night** | What holding the trade overnight costs or pays. |
| **EURUSD after** | Your total position in this symbol before and after the trade. |

Under the numbers is a list of **checks**, each with a mark:

- :ok[✓] passed.
- :bad[✕] failed, and blocks the trade. The reason is written next to it.
- :warn[!] worth knowing, but does not block the trade.

| Check | What it looks at |
| --- | --- |
| **Paper ticket** / **Live tickets** | Whether this kind of ticket is allowed on this account. |
| **Live quote** | That a fresh price exists. A price older than 60 seconds (the usual setting) is not good enough. |
| **Stop distance** | That the stop is far enough from the entry. |
| **Take profit** | That the target is on the right side of the entry. |
| **Ticket in flight** | That you do not already have a manual trade for this side still waiting. |
| **News blackout** | That no high-impact news event is due right now. |
| **Risk profile** and **Position size** | That your account has risk settings, and they give a size above zero. |
| **Signal checks** and **Account risk check** | The same limits every automatic trade must pass, on your account as it is now. |

> [!SUCCESS]
> When every check has a ✓, the button at the bottom turns on and reads, for example, **Paper Buy 0.1**. If it stays grey, the reason is written next to it.

## Send the trade

1. Click the button at the bottom of the ticket ((4)), for example **Paper Buy**.
2. For a **live** trade, a warning appears naming the account, the direction and the size. Read it.
3. Click {{Send live order}} to go ahead, or {{Back}} to change something.

> [!WARNING]
> Lascodia runs every check again when you send, with the prices at that moment. A trade that passed in the dry run can still be refused a second later, for example if the price moved.

### What happens next

```flow
Your ticket | Paper or live | ticket
-> paper
Paper trade opened | Nothing is sent to your broker | file-text
@caption A paper ticket opens a paper trade straight away. You see it in the Account panel on the chart.
```

```flow
Your ticket | Live | ticket
-> becomes
A manual signal | A trade request, like the ones strategies send | zap
-> checked against
Your limits | Risk profile and account checks, again | shield-check
-> sent to
Your MetaTrader 5 terminal | The Lascodia EA places the order at your broker | laptop
-> shows on
Orders and Positions | Follow it in the console | list-checks
@caption A live ticket. If the EA has not placed it within 15 minutes (the usual setting), it expires unused.
```

- A message at the bottom of the screen tells you the signal or paper trade was created.
- If your organisation requires approval, the trade waits until a second authorised person approves it. It is checked again then.

## Follow your orders and positions

An **order** is an instruction waiting to be filled. A **position** is a trade that is open now.

- The **Account** panel on the chart (the panel strip on the right) shows your positions, working orders, live signals and paper trades for this symbol.

  ![The Account panel on the chart: counts of positions, working orders, live signals and paper trades, then each one on this symbol](trade-account-panel "/chart-analysis/EURUSD")

- **Trading → Orders** (`/orders`) lists every order. Its {{+ New manual signal}} button is another way to trade by hand; it goes through the same checks.

  ![The Orders page](trade-orders "/orders")

- **Trading → Positions** (`/positions`) lists every open position.

  ![The Positions page](trade-positions "/positions")

**Change or close a trade on the chart.** Open positions and working orders are drawn on the chart as lines.

- Drag a position's stop or target line to move it.
- Click a position's entry line to close all of it, or part of it.
- Drag a working order's price line to move the order. Its stop and target move with it unless you untick **Move the stop and target with it**.

Each change opens a confirmation showing the account, the new risk in money and the distance in pips and ATR. A change waits as a faded line until your terminal confirms it. If it is refused, the line snaps back and the reason is shown.

## Trade from the ladder

The **price ladder** lets you place orders by clicking a price. Open it with the **Price ladder (DOM): trade from the book** button in the panel strip. [Using the chart](/docs/user-guide#the-price-ladder-order-book) explains its columns.

1. Choose the account ((1)).
2. Choose **Paper** or **Live** ((2)). Paper is the default.
3. To trade now, click **Buy MKT** or **Sell MKT** ((3)). This works on paper and live.
4. To trade at a price, switch to **Live** and click a row. (Paper trades fill at market only, so the ladder asks you to switch.)

| You click | You get |
| --- | --- |
| A row in the **Bid** column | A **buy limit**: buy if the price falls to there. |
| A row in the **Bid** column with [[Shift]] held | A **sell stop**: sell if the price falls to there. |
| A row in the **Ask** column | A **sell limit**: sell if the price rises to there. |
| A row in the **Ask** column with [[Shift]] held | A **buy stop**: buy if the price rises to there. |

5. A confirmation opens with the size, the money at risk, the R, the account and any failed check. Click {{Send paper order}} or {{Send live order}}, or {{Back}}.

![The ladder's trading controls: ((1)) the account, ((2)) paper or live, ((3)) buy or sell now, ((4)) OCO pairs, ((5)) one-click trading](trade-ladder "/chart-analysis/EURUSD")

**Stops and targets.** Ladder orders get a stop loss and take profit automatically. Set them with **SL** ((1)), in ATR (1.5 to start), and **TP** ((2)), in R (2 to start; 0 means no target).

![The ladder's bracket settings: ((1)) the stop distance in ATR, ((2)) the target in R](trade-ladder-brackets "/chart-analysis/EURUSD")

> [!TIP]
> On a futures, crypto or stock chart, clicking a ladder row opens that market's own ticket at the price you clicked instead (see [Futures, crypto and stocks](#futures-crypto-and-stocks)). One-click and OCO are off there.

**Move or cancel.** Your orders show as chips in the **Buy** and **Sell** columns. Drag a chip to another row to move the order; its stop and target move with it. Click the **×** on a chip to cancel it.

### OCO pairs

**OCO** means *one cancels the other*: two orders, and when one fills the other is cancelled. It is useful when you want to catch a move either up or down. OCO works for live orders only.

1. Switch to **Live**, then click {{OCO}} ((4)).
2. Click one price for a buy and one price for a sell. The button shows **leg 2…** while it waits for the second click.
3. Check both legs in the confirmation and click {{Send OCO pair}}.

> [!NOTE]
> Cancelling one leg of an OCO pair cancels the other too. A leg that has already filled is a position and stays open.

### One-click trading

**One-click** sends ladder clicks without the confirmation. It is off by default and works for live orders only.

1. Switch to **Live** and choose the account.
2. Click {{One-click}} ((5)) and confirm.
3. The button now reads **ARMED · one-click**. Click it to switch it off.

> [!DANGER] One-click sends real orders without asking
> While it is armed, **every click on the ladder sends a live order** on that account for that symbol, straight away. Lascodia still checks each order, but there is no confirmation. It is forgotten when you reload the page, change the account or change the symbol.

## Futures, crypto and stocks

Futures, crypto and stocks trade on exchanges, not through MetaTrader 5. When the chart shows one of these, **Trade** opens a different ticket built for them. It works only when your platform has switched these markets on and your organisation has connected an exchange or broker account (see [Connect a broker or exchange](/docs/connections-guide)).

![The ticket for an exchange-traded symbol: ((1)) your trading account, ((2)) the exchange account, ((3)) the order type and how long it lasts, ((4)) the quantity, ((5)) send](trade-venue-ticket "/chart-analysis/6EZ6")

1. Choose the **Trading acct** ((1)) and the **Venue acct** ((2)): the exchange or broker account that will carry the order.
2. Click **Buy** or **Sell**.
3. Choose the **Type** ((3)): **Market** (now), **Limit** (at your price or better), **Stop** (once the price reaches a trigger) or **Stop limit**. Next to it, choose how long the order lasts:
   - **GTC**: good till cancelled.
   - **DAY**: until the end of the trading day.
   - **IOC**: fill what you can now, cancel the rest.
   - **FOK**: fill all of it now, or nothing.
4. Type the **Quantity** ((4)) in the market's own unit: contracts, shares or coins. The line under it shows the smallest step and what one price tick is worth.
5. For Limit and Stop orders, type the **Limit** or **Trigger** price, or click {{quote}} to copy the current price.
6. Set **Stop (ticks)** and **Target (ticks)**. A tick is the smallest price step of the market.
7. Read the dry run, then click the send button ((5)), for example **Buy 1 contract**.
8. A step called **Send this order?** shows the order exactly as it will be sent. Check it and click **Send**.

| Dry-run line | What it tells you |
| --- | --- |
| **Price** | The price the order is valued at, and where it came from. |
| **Notional** | The full value of the trade. |
| **Margin** | The deposit the exchange holds while it is open. |
| **Liquidation** | For leveraged crypto, the price where the exchange would close it for you. |
| **Risk at stop** and **Reward** | Money lost at the stop, and won at the target. |
| **Fees** | The estimated exchange fee. |
| **Session** | Whether the market is open now. |

- **Post-only** (Limit orders) makes sure your order only adds to the book and never trades at once.
- **Reduce-only** (futures and crypto derivatives) can only shrink a position, never open a new one.
- **Leverage** and margin mode (crypto derivatives) are shown for the dry run only. Your account's own settings apply.

> [!WARNING]
> If the ticket says venue tickets are switched off, your platform has not turned these markets on for trading yet. You can still look at prices and do the dry run. Ask your platform team.

> [!DANGER]
> When the venue account is **live**, the confirmation says so: it is a real order at that exchange.

## If something goes wrong

?? The send button stays grey.
   The reason is written next to it. The most common ones:
   - *Choose the account the ticket is for.* Pick an account at the top of the ticket.
   - *Set a stop loss: manual trades are refused without one.* Add a stop.
   - *The stop is … ATR from the entry; it must be at least …* Move the stop further away.
   - A failed check with ✕ in the list. Read its reason.

?? "Paper tickets fill at market".
   Paper trades cannot wait for a price. Choose **Market**, or switch to **Live** for an order at a price.

?? "Live manual tickets are switched off" or "a Real account".
   Your platform allows paper only, or does not allow live tickets on real-money accounts. Use paper, or ask your platform team.

?? "The last quote is … old".
   The market may be closed, or prices have stopped arriving. Try again when the market is open.

?? I sent a live trade but nothing appears in Positions.
   1. Open **Trading → Trade Signals** and find your manual signal. Its status says where it is.
   2. Check your MetaTrader 5 terminal is connected (the [Connect MetaTrader 5](/docs/ea-install) guide shows how).
   3. A signal the terminal has not placed within 15 minutes expires.

```decide
Did my trade reach the broker?
Yes: It is listed on the Positions page (or on Orders while it waits for its price).
No: Paper trades never do. For a live trade, open Trade Signals and read the status of your manual signal.
Not sure: Open the Account panel on the chart. Paper trades and live signals are counted separately.
```

## Where to next

```cards
chart-candlestick | Using the chart | The ladder, alerts and replay explained | /docs/user-guide
book-open | Words explained | Every trading word in one plain sentence | /docs/glossary
plug | Connect MetaTrader 5 | Link the terminal that places live trades | /docs/ea-install
cable | Connect a broker or exchange | For futures, crypto and stocks | /docs/connections-guide
```

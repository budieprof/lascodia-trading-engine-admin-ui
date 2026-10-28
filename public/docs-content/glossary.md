# Words explained

> [!SUMMARY]
> Every trading and console word used in this help, in one plain sentence each, from A to Z. Many have an example.
> Other guides link straight to a word here, so you can look it up and jump back.

```cards
book-open | A to B | Account, API key, ATR, backtest, bid and ask, broker | /docs/glossary#a-to-b
chart-candlestick | C to D | Candle, CFD, crypto, demo account, drawdown | /docs/glossary#c-to-d
plug | E to K | EA, equity, exchange, futures, kill switch | /docs/glossary#e-to-k
scale | L to M | Leverage, limit order, lot, margin, MetaTrader 5 | /docs/glossary#l-to-m
layers | O to P | OCO, order book, organisation, paper trading, pip | /docs/glossary#o-to-p
shield-check | R to S | Risk profile, role, signal, spread, stop loss | /docs/glossary#r-to-s
clock | T to W | Take profit, terminal, tick, timeframe, webhook | /docs/glossary#t-to-w
```

## How the main words fit together

You often meet these words together. This picture shows how they connect, from your money down to a single trade.

```stack
Broker | Holds your money in a trading account | landmark
-> you connect it through
MetaTrader 5 and the EA | The trading program and the Lascodia add-on | laptop
-> which places
Orders | Instructions to buy or sell | ticket
-> that become
Positions | Trades that are open now, each with a stop loss and take profit | wallet
@caption From broker to trade. Each word is explained below.
```

## A to B

### Account

A **trading account** is your account at a broker, holding the money you trade with. Lascodia shows each account's balance, trades and risk. *Example: a MetaTrader 5 account number at your broker, connected through the EA.*

### API key

A secret code that lets a program (not a person) sign in and use Lascodia or an exchange for you. Keep it private, like a password.

### ATR

**Average True Range**: how far the price usually moves in one candle, averaged over the last 14 candles. Lascodia uses it to judge whether a stop loss is too close. *Example: if EURUSD's hourly ATR is 0.0012 (12 pips), a stop 3 pips away will probably be hit by normal wobbles.*

### Backtest

A test of a strategy on past prices, to see how it would have done. A good backtest is not a promise of future results.

### Balance

The money in your account, not counting trades that are still open. Compare [equity](#equity-account-value).

### Bid and ask

The **bid** is the price you can sell at. The **ask** is the price you can buy at. The ask is always a little higher; the gap is the [spread](#spread). Lascodia's charts show the bid.

```flow
Bid 1.11220 | You can sell here | trending-down
-> the gap is the spread
Ask 1.11232 | You can buy here | trending-up
@caption Example: the spread here is 0.00012, which is 1.2 pips.
```

### Broker

The company that holds your trading money and carries out your trades. You connect to it through MetaTrader 5 (for forex) or through an exchange account (for futures, crypto and stocks).

## C to D

### Candle

One bar on a price chart, showing the price during one period of time: where it opened, the highest and lowest it went, and where it closed.

```stack
High | The thin line at the top: the highest price | trending-up
-> then the body
Open and close | Green: closed higher than it opened. Red: closed lower. | chart-candlestick
-> then the lower line
Low | The thin line at the bottom: the lowest price | trending-down
@caption The parts of a candle, read from the top down.
```

### CFD

A **contract for difference**: a deal with your broker to swap the change in a price, without owning the thing itself. Many MetaTrader 5 symbols are CFDs.

### Contract

The unit you trade futures in. One contract has a fixed size set by the exchange. *Example: one euro futures contract covers 125 000 euros.*

### Crypto

Digital money such as Bitcoin (BTC) or Ether (ETH), traded on crypto exchanges. *Example: BTC-USDT is Bitcoin priced in the US-dollar coin USDT.*

### Currency pair

Two currencies priced against each other. The first is the one you buy or sell; the second is what it is priced in. *Example: EURUSD 1.1120 means one euro costs 1.1120 US dollars.*

### Demo account

A broker account with pretend money, for practice. It behaves like a real account, but no real money is at stake. New organisations start with demo accounts.

### DOM

Short for **depth of market**: another name for the [order book](#order-book).

### Drawdown

How far your account has fallen from its highest point. *Example: if your account grew to 10 000 and then fell to 9 000, the drawdown is 10%.*

## E to K

> [!NOTE] One word, two meanings
> **Equity** can mean your account's value right now (see below), or a company share (see [stock](#stock)). The screen around it tells you which.

### EA

Short for **Expert Advisor**: an add-on program that runs inside MetaTrader 5. The Lascodia EA sends prices to Lascodia and places the trades Lascodia asks for.

### Enrollment token

A one-time code you paste into the Lascodia EA to connect a new MetaTrader 5 terminal to your organisation.

### Equity (account value)

Your account's value right now, including the profit or loss of trades still open. *Example: a balance of 1 000 with an open trade 50 down gives an equity of 950.*

### Exchange

A marketplace where futures, stocks or crypto are traded, such as the CME for futures or Binance for crypto. Lascodia also calls it a **venue**.

### Fill

When your order is carried out. *Example: "filled at 1.11232" means you bought at that price.*

### Futures

A contract to buy or sell something at a set price on a set date, traded on an exchange. *Example: 6EZ6 is the euro future for December 2026.*

### Indicator

A calculation drawn on a chart to help you read it, such as a moving average. Also called a **study**.

### Kill switch

An emergency stop. When it is on, no new trades are opened. Open positions are not closed by it.

## L to M

Lots, leverage and margin work together. This example uses EURUSD at 1.1000 and 1:30 leverage.

| You trade | Size in euros | Worth in dollars | Margin held (1:30) | One pip is worth |
| --- | --- | --- | --- | --- |
| 0.01 lots | 1 000 | 1 100 | about 37 | 0.10 dollars |
| 0.10 lots | 10 000 | 11 000 | about 367 | 1 dollar |
| 1.00 lot | 100 000 | 110 000 | about 3 667 | 10 dollars |

### Leverage

Trading a bigger amount than the money you put down. It makes both gains and losses bigger. *Example: with 1:30 leverage, 1 000 of your money controls a 30 000 trade, so a 1% move is a 300 gain or loss.*

### Limit order

An order to buy at a set price or lower, or sell at a set price or higher. It waits until the market gets there.

### Liquidation

When an exchange closes a leveraged position by itself because your deposit no longer covers the loss. The ticket shows the price where this would happen.

### Live trading

Real orders sent to your broker or exchange. Compare [paper trading](#paper-trading).

### Lot

The unit of trade size in forex. One standard lot is 100 000 units of the first currency. *Example: 0.10 lots of EURUSD is 10 000 euros.*

### Margin

Money your broker sets aside from your account while a trade is open, as a deposit. It comes back when the trade closes. *Example: a 30 000 trade at 1:30 leverage needs about 1 000 of margin.*

### Market order

An order to buy or sell straight away, at the best price available now.

### MetaTrader 5

The trading program many brokers give their customers, often called MT5. Lascodia connects to it through the EA.

## O to P

### OCO

**One cancels the other**: two orders linked together. When one fills, the other is cancelled. *Example: a buy above the price and a sell below it, to catch a move either way.*

### Order

An instruction to buy or sell. It is **working** until it fills or is cancelled.

### Order book

The list of prices people are waiting to buy and sell at, and how much is waiting at each one. Lascodia shows it in the price ladder.

![The price ladder on the chart shows the order book: ((1)) how much buyers are waiting for at each price, ((2)) how much sellers are offering](glossary-order-book "/chart-analysis/EURUSD")

### Organisation

Your team's own private space in Lascodia. Your accounts, people, strategies and settings live in it, and nobody outside it can see them.

### Paper trading

Pretend trading: Lascodia works out what would happen at real prices, but nothing is sent to your broker. It is the default on the order ticket.

### Perpetual

A crypto futures contract with no end date, often written with "PERP". *Example: BTC-USDT-PERP.*

### Pine script

A small programming language for chart indicators and strategies, made popular by TradingView. Lascodia runs Pine version 6.

### Pip

A small, standard step in price. For most currency pairs it is the fourth decimal place (0.0001); for pairs with the Japanese yen it is the second (0.01). *Example: EURUSD moving from 1.1120 to 1.1135 is 15 pips.*

### Position

A trade that is open now. It is **long** if you bought (you gain when the price rises) and **short** if you sold (you gain when it falls).

## R to S

```stack
Take profit | Above the entry for a buy: the trade closes here with a gain | trending-up
-> the price rises to here
Entry | Where you buy | arrow-right
-> or falls to here
Stop loss | Below the entry for a buy: the trade closes here with a small, planned loss | shield
@caption Stop loss and take profit on a buy trade. For a sell, they swap sides.
```

### R multiple

**R** is the money you risk on a trade: what you lose if the stop loss is hit. Results are often given in R. *Example: risking 50 to make 100 is a 2R target.*

### Risk profile

A set of limits for an account: how much it may risk per trade, how many trades it may have open, and more. Lascodia checks every trade against it.

### Role

What a person may see and do in your organisation. *Example: a Viewer can only look; a Trader can place orders.*

### Second factor

A second proof of who you are when you sign in, on top of your password: a code from an authenticator app on your phone, or a security key. Also called **2FA**.

### Signal

A suggested trade: what to buy or sell, the entry, the stop loss and the take profit. Strategies send signals, and so does the order ticket. Lascodia checks every signal against your limits before a trade is placed.

### Slippage

The difference between the price you expected and the price you got. It happens when the price moves while your order is on its way.

### Spread

The gap between the ask (buy) price and the bid (sell) price. You pay it on every trade. *Example: bid 1.11220, ask 1.11232: the spread is 1.2 pips.*

### Stock

A share in a company, traded on a stock exchange. Also called an **equity**.

### Stop loss

A price where your trade closes by itself if the market goes against you, so a loss cannot grow past what you planned. Every manual trade in Lascodia needs one.

### Stop order

An order that waits until the price reaches a level, then trades. *Example: a buy stop above the price buys only if the price rises to it.*

### Strategy

A set of trading rules that runs by itself and sends signals when it sees an opportunity.

### Swap

A small fee or payment for holding a forex trade open overnight. It depends on the interest rates of the two currencies.

### Symbol

The short name of what you are trading or looking at. *Example: EURUSD, 6EZ6, BTC-USDT.*

## T to W

| Time in force | Means | Good for |
| --- | --- | --- |
| **GTC** | Good till cancelled | Orders you want to leave waiting |
| **DAY** | Until the trading day ends | Orders for today only |
| **IOC** | Immediate or cancel | Taking what is there now, without waiting |
| **FOK** | Fill or kill | All or nothing, right now |

### Take profit

A price where your trade closes by itself to bank the gain.

### Terminal

One copy of MetaTrader 5 running on a computer, with the Lascodia EA attached. Each terminal is connected to one broker account.

### Tick

One price update. For futures, a **tick** is also the smallest step the price can move. *Example: the euro future moves in ticks of 0.00005.*

### Time in force

How long an order stays waiting. **GTC**: until you cancel it. **DAY**: until the end of the trading day. **IOC**: fill what you can now, cancel the rest. **FOK**: fill all of it now, or nothing.

### Timeframe

How much time each candle on a chart covers. *Example: on a `1h` chart each candle is one hour.*

### Venue

Lascodia's word for an exchange or broker where futures, crypto or stocks are traded.

### Watchlist

Your list of symbols to keep an eye on, beside the chart.

### Webhook

A web address that Lascodia sends a message to when something happens, such as an alert firing. Another program at that address can then act on it. Lascodia signs each message so the receiver can check it is genuine.

## If something goes wrong

?? I cannot find a word.
   Use the search box at the top of the help pages. If it is still missing, tell your platform team so it can be added.

?? Is a pip the same for every symbol?
   No. For most currency pairs it is 0.0001. For pairs with the Japanese yen it is 0.01. Futures, crypto and stocks talk about **ticks** instead, and each market sets its own.

?? Why does my buy price differ from the chart?
   The chart shows the **bid**. You buy at the **ask**, which is higher by the [spread](#spread).

```decide
Is this trade using real money?
Yes: It is a live trade on a real-money (Real) account at your broker or exchange.
No: It is a paper trade, or a live trade on a demo account.
Not sure: Look at the account name and type in the ticket or the account picker. Paper is the default.
```

## Where to next

```cards
rocket | Start here | The five steps to get going | /docs/getting-started
chart-candlestick | Using the chart | Prices, the order book, alerts and replay | /docs/user-guide
shopping-cart | Placing trades | Practise on paper, then trade for real | /docs/trading-guide
```

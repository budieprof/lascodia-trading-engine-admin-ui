# Start here

> [!SUMMARY]
> Lascodia brings your trading accounts into one website. You see live prices, your trades and your risk in one place, and strategies can trade for you within limits you set.
> Getting going takes five steps: get an organisation, invite your team, connect MetaTrader 5, open a chart, and choose strategies. Most people finish in under an hour.

```flow
Get an organisation | Your team's own space in Lascodia | building
Invite your team | Give each person the right role | user-plus
Connect MetaTrader 5 | Link a trading account | plug
Open a live chart | Prices, orders and positions | chart-candlestick
Choose strategies | Decide what may trade for you | target
@caption The five steps. The Get started page ticks each one off as you finish it.
```

## How the pieces fit together

You only ever use the website. Behind it, the Lascodia engine does the work: it checks every trade against your limits, keeps the records, and talks to MetaTrader 5. MetaTrader 5 is the trading program your broker gives you, and it places the actual trades.

```stack
You | In your web browser, on any computer | user
-> you click and read here
Lascodia console | This website: charts, trades, settings, reports | monitor
-> sends your instructions
Lascodia engine | Checks every trade against your limits and keeps the records | shield-check
-> passes trades on through
MetaTrader 5 with the Lascodia EA | The broker's trading program, on your computer or a server | laptop
-> places the trade with
Your broker | Where your money actually is | landmark
@caption Your money stays with your broker. Lascodia never holds it.
```

> [!NOTE] Demo accounts first
> New organisations can only connect MetaTrader 5 **demo** accounts. A demo account trades with pretend money, so you can learn safely. Live (real-money) accounts are turned on later, by agreement with the platform team.

## Your progress page

The **Get started** page keeps track of where you are. Open it from the sidebar (**Organisation → Get started**) at any time.

![The Get started page: ((1)) each step, ((2)) how many are done, ((3)) the button that takes you there](gs-onboarding "/onboarding")

- A green tick means the step is done. An empty circle means it is still to do.
- {{Open}} or {{Start}} takes you straight to the page where that step is done.
- "Ask an administrator" means your role cannot do that step. Someone with the Admin or Owner role can.

## Step 1 — Get an organisation

An **organisation** is your team's own private space in Lascodia. Your accounts, people, strategies and settings live in it, and nobody outside it can see them.

There are two ways to get one:

```decide
Has someone already invited you?
Yes: Open the invitation e-mail and follow its link. Your organisation already exists, so go to Step 2.
No: On the sign-in page, choose Create an organisation (shown when the platform is accepting sign-ups).
```

To create one yourself:

1. Go to the sign-in page and choose **Create an organisation**.
2. Enter your e-mail address, your name and your organisation's name.
3. Open the e-mail Lascodia sends you. Follow its link to confirm your address and choose a password.
4. Set up a **second factor**. This is a code from an authenticator app on your phone (for example Google Authenticator or Microsoft Authenticator), or a security key. You will use it each time you sign in.
5. Sign in. Depending on the platform's rules, your organisation is ready straight away or after the platform team approves it. You become its **Owner**.

![The sign-in page. Choose Continue to sign in and enter your e-mail, password and second-factor code](gs-signin "/login")

> [!TIP]
> Install the authenticator app before you start, so the sign-up is not interrupted.

## Step 2 — Invite your team

Each person signs in with their own account, so you can see who did what. Give each person a **role**: a role decides what they can see and do.

1. Open **Organisation → Invitations** in the sidebar.
2. Type the person's e-mail address ((1)).
3. Choose their role ((2)). If they need more than one role, use {{Add another role}}.
4. Click {{Send invitation}} ((3)). The invitation is valid for 7 days.

![Invite someone: ((1)) their e-mail, ((2)) their role, ((3)) send](gs-invite "/iam/invitations")

Which role should I give?

| Role | Good for | They can |
| --- | --- | --- |
| **Viewer** | Anyone who only needs to look | See dashboards, lists and charts. Change nothing. |
| **Trader** | People who place trades | Place, change and cancel orders; approve signals. |
| **Analyst** | People who research | Run backtests and training. |
| **RiskManager** | Whoever looks after risk | See everything; set risk limits, use the kill switches, close positions. |
| **Operator** | Day-to-day running | Settings, kill switches, risk and accounts. |
| **Admin** | Team leads | Everything an Operator can do, plus people and roles. |
| **Owner** | The organisation's owners | Everything, including exporting all data and closing the organisation. |
| **Billing** | Your finance contact | Plan, usage and invoices. No trading data. |
| **Investor** | Investors in a fund | Read-only performance statements for the accounts you share. |

> [!TIP] Give the smallest role that does the job
> It is easy to give more later. You can only give roles whose permissions you hold yourself.

### Make a second factor compulsory

A second factor stops someone who has guessed or stolen a password from getting in. Turn it on for everyone:

1. Open **Organisation → Security policy**.
2. Tick **Require a second factor** ((1)).
3. Click {{Save policy}} ((2)).

![Security policy: ((1)) require a second factor, ((2)) save](gs-second-factor "/iam/security")

> [!WARNING]
> Once this is on, anyone without a second factor is asked to set one up at their next sign-in.

## Step 3 — Connect MetaTrader 5

This links a trading account to Lascodia. You install a small add-on, the **Lascodia EA**, in MetaTrader 5. EA stands for *Expert Advisor*, MetaTrader's name for an add-on program. The EA sends prices to Lascodia and places the trades Lascodia asks for.

The **Guided connection** page walks you through it and turns green when it works. Open it from **Organisation → Connect a terminal → Guided connection**.

```flow
Download the EA | One file for MetaTrader 5 | download
Create a token | A one-time key for this terminal | key-round
Set up MetaTrader 5 | Allow the address, attach the EA | settings
Wait for green | The page confirms the link | circle-check-big
```

![The guided connection: ((1)) download the EA, ((2)) name the terminal, ((3)) create its one-time token](gs-connect "/organisation/terminals/connect")

> [!SUCCESS]
> The last step turns green and says the terminal is connected. Your account's balance and positions now appear in Lascodia.

The [Connect MetaTrader 5](/docs/ea-install) guide has every click, with pictures, and fixes for anything that goes wrong.

## Step 4 — Open a live chart

Open **Market Data**, or go straight to a symbol such as EURUSD (the euro against the US dollar).

![The chart: ((1)) pick a symbol, ((2)) pick a timeframe, ((3)) your watchlist, ((4)) the symbol's details and today's prices](gs-chart "/chart-analysis/EURUSD")

- **Symbol** ((1)): what you are looking at. Click it and type to search.
- **Timeframe** ((2)): how much time each candle covers. `1h` means each candle is one hour.
- **Watchlist** ((3)): the symbols you follow. Click one to switch the chart to it.
- **Details** ((4)): the latest price, and today's open, high and low.

> [!NOTE] Reading a candle
> Each candle shows one period of time. Green means the price ended higher than it started, red means lower. The thin lines show the highest and lowest prices in that period.

Your layout (indicators, drawings, panels) is saved automatically and follows you to any computer. The [Using the chart](/docs/user-guide) guide explains everything on this screen.

## Step 5 — Choose strategies

A **strategy** is a set of trading rules that runs by itself. When its rules see an opportunity, it sends a **signal**: a suggested trade. Lascodia checks every signal against your limits before any trade is placed.

1. Open **Organisation → Strategy subscriptions**.
2. Under **Platform strategies** ((1)), find a strategy you want.
3. Click {{Subscribe...}} ((2)) and choose which of your accounts should receive its signals.

![Strategy subscriptions: ((1)) the strategies on offer, ((2)) subscribe your accounts](gs-strategies "/organisation/strategies")

> [!WARNING] Check who receives signals
> If nobody in your organisation has subscribed to a strategy, its signals go to every account whose terminal follows that symbol. Subscribing limits the strategy to the accounts you choose.

## Want to look around first?

When the platform runs it, a **demo** (`/demo`, linked from the sign-in page) shows the chart and order book playing back recorded prices. Everything there is clearly labelled as recorded, and nothing can be traded.

## If something goes wrong

?? I did not get the sign-up or invitation e-mail.
   Check your spam or junk folder first. Invitations last 7 days. If yours has expired, ask the person who invited you to send a new one from **Organisation → Invitations**.

?? A step on the Get started page says "Ask an administrator".
   Your role is not allowed to do that step. Ask someone in your organisation with the **Admin** or **Owner** role.

?? I lost my phone with the authenticator app.
   Ask an Admin or Owner in your organisation to reset your second factor. If you are the only Owner, contact the platform team.

?? The guided connection never turns green.
   The [Connect MetaTrader 5](/docs/ea-install#if-something-goes-wrong) guide lists every message the page can show, and what to do about each.

## Where to next

```cards
plug | Connect MetaTrader 5 | Every click of the terminal set-up, with fixes | /docs/ea-install
chart-candlestick | Using the chart | Prices, the order book, alerts and replay | /docs/user-guide
shopping-cart | Placing trades | Practise on paper, then trade for real | /docs/trading-guide
book-open | Words explained | Pips, lots, margin and more, in plain words | /docs/glossary
```

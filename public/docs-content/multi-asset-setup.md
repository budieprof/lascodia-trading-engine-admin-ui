# Switching on futures, crypto and stocks

> [!SUMMARY]
> Lascodia can already trade exchange futures, crypto and US stocks beside forex. That code is built and tested, but it ships **switched off**: no exchange has seen a real order from it yet.
> This guide shows what must be in place first (margins, fees, symbol matching), which switches turn each part on, and the safe order to do it in: testnet first, then watching only, then small real trades, then normal.

```flow
Load margins and fees | The numbers the risk check and costs use | scale
Check symbol matching | Each exchange's names mapped to ours | link
Connect a venue account | Paper (testnet) first | cable
Turn the switches on | In order, on the Config page | toggle-right
Roll out step by step | Testnet, shadow, capped live, normal | route
@caption The whole job, start to finish. Forex trading through MetaTrader 5 is not touched at any step.
```

## What is already built, and why it is off

A **venue** is any place outside MetaTrader 5 where Lascodia can trade: a crypto exchange, a futures broker or a stock broker. Each one has an **adapter**: a small piece of the engine that speaks that venue's language.

```stack
Lascodia engine | Checks every trade against your limits, as it does for forex | shield-check
-> sends instructions to
Execution router | Decides: MetaTrader 5 (the EA) or a venue adapter | route
-> one adapter per venue
Venue adapters | Binance, Coinbase, Kraken, Bybit, OKX, Rithmic, CQG, Interactive Brokers, Tradovate, Alpaca, Tradier | plug
-> places orders at
Exchanges and brokers | Where the money and the positions really are | landmark
@caption MetaTrader 5 accounts keep going through their EA exactly as before.
```

| Asset | Venues with an adapter |
| --- | --- |
| Crypto | Binance (spot and USDⓈ-M perpetuals), Coinbase Advanced Trade, Kraken (spot and futures), Bybit, OKX |
| Exchange futures | Rithmic, CQG, Interactive Brokers, Tradovate |
| US stocks | Interactive Brokers, Alpaca, Tradier |

**Connections** (**Configuration → Connections**) lists every adapter in this build under **Adapters in this build**.

Why everything is off:

- **Nothing has traded at a real venue yet.** Each adapter was built from the venue's published documents and tested against a faithful practice copy of that venue (a simulator). Real accounts, keys and testnets were never used.
- **Forex must not change.** Every new path sits behind a switch that is off by default. With the switches off, forex lot sizes, stops, risk checks and costs are proven identical to before.
- **Missing data means "no".** The risk check refuses any exchange-traded trade it cannot price. With no margin numbers loaded, every futures order is refused.

> [!NOTE] Forex is never affected
> All the switches in this guide act on venue accounts only. MetaTrader 5 accounts, their EA and their trades behave the same whether the switches are on or off.

## Where the switches live

Every switch is an engine setting on the **Config** page (**System → Config**, address `/engine-config`). Only platform staff can change them. Every change is recorded with who made it, when, the old and new value, and the reason.

1. Open **System → Config**.
2. Type the start of the setting's name in the search box ((1)), for example `Execution:`.
3. Change the value in the **Value** column ((2)). On/off settings are a `true` / `false` list.
4. Click {{Save}} on that row ((3)).

   ![The Config page searched for "Execution:": ((1)) the search box, ((2)) a value, ((3)) save that row](ma-config-search "/engine-config")

5. A **Save 1 change?** window opens. Type why you are making the change ((1)).
6. Leave **Apply immediately** ((2)) unticked unless this is an emergency.
7. Click {{Save 1}} ((3)).

   ![Saving a change: ((1)) the reason, ((2)) the break-glass box, ((3)) confirm](ma-config-review "/engine-config")

A **Hot** badge means the new value is used within seconds. **Cold** means the engine must restart first.

> [!WARNING] Loosening risk waits 24 hours
> A change that makes risk *looser* (for example a higher leverage, a bigger cap, or turning a safety check off) needs a reason and is held for a **cooling-off** period before it takes effect. It is 24 hours today (`Governance:CoolingOffHours`). The page tells you when the change will apply. **Apply immediately** skips the wait; use it only in an emergency, because it is flagged in the audit record.

> [!TIP]
> Some risk settings can also be set for one organisation or one trading account, on **Organisation → Settings** (choose the account at the top). The most specific value wins: account, then organisation, then platform.

## The on/off switches

Turn them on in this order. Each one depends on the ones before it.

```flow
Risk models | Risk:MultiAsset:Enabled | shield-check
Router | Execution:Router:Enabled | route
Fills | Execution:Fills:Enabled | receipt
Protection and trailing | Execution:Protection / Trailing | shield
Entries last | Execution:Entries:Enabled | play
@caption New trades (entries) come last, once everything that looks after an open trade is already working.
```

| Setting | What it does when `true` | Today |
| --- | --- | --- |
| `Risk:MultiAsset:Enabled` | Prices futures, crypto and stocks with their own margin rules, and adds checks for market hours, contract expiry, funding, liquidation distance and the day-trading rule. | :muted[false] |
| `Execution:Router:Enabled` | Lets the engine send instructions (close, change stops, cancel) to venue accounts instead of only to the EA. | :muted[false] |
| `Execution:Fills:Enabled` | Reads the venue's **fills** (the record of each trade done) and books them onto orders and positions, with fees and profit. | :muted[false] |
| `Execution:Protection:Enabled` | Keeps a stop loss and take profit in place at venues that cannot attach them to a position, using orders that can only reduce the position. When one fills, the other is cancelled. | :muted[false] |
| `Execution:Trailing:Enabled` | Moves venue stops along behind the price, only ever tighter, the same way forex stops trail. | :muted[false] |
| `Execution:Reconciliation:Enabled` | Every 60 seconds, compares the engine's positions and open orders with the venue's, and reports any difference. | :muted[false] |
| `Execution:Reconciliation:Mode` | `report` only reports differences. `act` also corrects a venue account after the same difference is seen 3 times in a row. | :info[report] |
| `Execution:Entries:Enabled` | Places **new** trades at venues. Needs the router and the risk models on as well. | :muted[false] |
| `Research:MultiAsset` | Backtests and research price futures, crypto and stocks with their own fees, funding and roll costs. | :muted[false] |
| `MarketData:InstrumentCandles:Enabled` | Builds candles for futures, crypto and stocks from the trades the engine stores. | :muted[false] |
| `Instruments:MathV2` | Uses each instrument's own tick size and contract terms for price and size maths. | :ok[true] |
| `Instruments:ReferenceSync:Enabled` | Downloads each venue's list of instruments once a day (every 1,440 minutes). | :ok[true] |

You can see the execution switches at a glance at the top of the **Connections** page:

![The execution switches as Connections shows them. Change them on the Config page, not here](ma-switches "/connections")

> [!NOTE] About `Instruments:MathV2`
> It was turned on on 27 October 2026, after a check that it gives the same answers as before for every live forex symbol. It only changed 16 symbols that had no row of their own (such as USDNGN and DE40).

### Instrument lists from each venue

The daily instrument download has one switch per source: `Instruments:ReferenceSync:Source:<source>:Enabled`. It brings in each instrument's tick size, minimum quantity and the venue's own name for it.

| Source | Today | Notes |
| --- | --- | --- |
| `binance`, `bybit`, `coinbase`, `kraken`, `okx` | :ok[true] | Public lists, no key needed |
| `kraken-futures` | :ok[true] | Kraken perpetual futures |
| `databento`, `databento-equities`, `polygon` | :muted[false] | Need a vendor API key in the engine's secret settings first |

### The US day-trading rule

`Risk:MultiAsset:Equities:DayTradingRule` decides how the engine treats day trading in US stock **margin accounts** (accounts that can borrow from the broker). A **day trade** is buying and selling the same stock on the same New York trading day.

| Value | What the engine does |
| --- | --- |
| `PatternDayTrader` (default) | The old rule. If the account holds less than $25,000 (`…:PdtMinEquity`) and has already made 3 day trades (`…:PdtMaxDayTrades`) in the last 5 business days, the next trade is refused. |
| `IntradayMargin` | The new rule. The engine stops counting day trades. It still refuses any trade without enough margin, before the trade is sent. |

In plain words: the US regulator FINRA is retiring the "pattern day trader" rule, with its $25,000 minimum and day-trade count. In its place, brokers simply stop you borrowing more than your margin allows during the day. The change took effect on 4 June 2026 (FINRA Regulatory Notice 26-10), and brokers have until 20 October 2027 to move.

> [!WARNING] Switch only when the broker has
> Choose `IntradayMargin` only for a broker that has already moved to the new rule. In both modes, if the broker itself still flags the account as a pattern day trader and it is under the minimum, the engine obeys the broker and refuses the trade.

Cash accounts (no borrowing) are not affected by either rule. When the broker reports it, a buy in a cash account may not spend more than the account's settled cash.

## Margin requirements

**Margin** is the money a venue holds back while a trade is open. The risk check uses it to decide how big a trade may be. Each asset class has its own kind of row:

| Kind on the page | What one row holds | Where to find the numbers |
| --- | --- | --- |
| **Futures (per contract)** | Initial and maintenance margin per contract, overnight and (optionally) intraday | The exchange's margin page for the product (for CME, the **Margins** tab of each product) |
| **Crypto leverage tier** | For one band of trade size: the highest leverage allowed and the maintenance rate | The exchange's leverage-tier (risk limit) page |
| **Equity house rate** | Initial and maintenance rates for stocks | Regulation: 50% initial (Reg T), 25% maintenance (FINRA 4210) |

> [!DANGER] An empty table refuses every exchange-traded order
> The risk check never guesses. If it finds no margin row for an instrument, it refuses the trade. This is on purpose: a wrong guess could let a far bigger position through than the venue allows. Before turning `Risk:MultiAsset:Enabled` on for a venue, load its margins.

Open **Configuration → Margin Requirements** (`/reference/margin-requirements`).

![Margin requirements: ((1)) filter by kind, ((2)) how rows are chosen, ((3)) a row in force, ((4)) add a row](ma-margins "/reference/margin-requirements")

How the engine picks a row ((2)):

- A futures **root** row (for example `6E`) covers every contract of that root (`6EZ6`, `6EH7`…) that has no row of its own.
- A row for a named venue beats a row with the venue left empty.
- When several rows match, the one with the latest start date that is already in force wins.

What is loaded today: one equity row (`*`, meaning every stock: 50% initial, 25% maintenance) and 1,349 crypto leverage tiers for `bybit-linear`, `okx-swap` and `kraken-futures`, read from those venues on 27 October 2026. **No CME futures margins are loaded**, so every futures trade is refused until they are.

To add a single row:

1. Click {{Add a row}} ((4)).
2. Choose the **Kind**, then fill in the **Symbol or futures root** and, if the numbers are for one venue only, the **Venue**.
3. Enter the margins exactly as the venue publishes them.
4. Set **Applies from (UTC date)**, the **Source** (the page address and the date you read it), and a **Reason**.
5. Click {{Save}}.

![The new-row form for a futures margin. The orange notes list what is still missing](ma-margin-form "/reference/margin-requirements")

> [!WARNING]
> Lower margins let larger positions pass the risk check. Enter the venue's published terms, never estimates.

### Importing many rows from a file

Loading hundreds of tiers by hand is slow, so the engine also takes a CSV file (a spreadsheet saved as text). There is no button for this on the page yet; it is one call to the engine. It needs the `platform.data.manage` permission.

The file has a header row. Required columns: `Kind`, `Symbol`, `EffectiveFromUtc`, `Source`. Optional: `Venue`, `Currency` (default USD), `InitialMargin`, `MaintenanceMargin`, `IntradayInitialMargin`, `IntradayMaintenanceMargin`, `NotionalFloor`, `NotionalCap`, `MaxLeverage`, `InitialMarginRate`, `MaintenanceMarginRate`, `MaintenanceAmount`. Rates are fractions: `0.005` means 0.5%.

An example `margins.csv` with one futures root and one crypto tier. It shows the layout only: replace each `<…>` with the venue's published number.

```bash
Kind,Symbol,Venue,Currency,EffectiveFromUtc,InitialMargin,MaintenanceMargin,NotionalFloor,NotionalCap,MaxLeverage,MaintenanceMarginRate,Source
FuturesContract,6E,,USD,2026-11-02,<initial>,<maintenance>,,,,,"<CME page> read 2026-11-02"
CryptoLeverageTier,BTC-USDT-PERP,bybit-linear,USDT,2026-11-02,,,0,<cap>,<max>,<rate>,"<venue page> read 2026-11-02"
```

1. Send the file with `"dryRun": true` first. Nothing is saved; the answer lists every row it would add and every error.

   ```bash
   jq -n --rawfile csv margins.csv '{csv: $csv, dryRun: true, reason: "CME margins 2026-11"}' |
   curl -s -X POST "https://<your-engine-host>/api/v1/lascodia-trading-engine/reference/margin-requirements/import" \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary @-
   ```

2. When the dry run shows no errors, send the same file with `"dryRun": false`.

> [!SUCCESS]
> The answer shows `inserted` (rows added) and `alreadyPresent` (rows that were already there). The new rows appear on the page, and one audit record is written.

Rules worth knowing:

- **All or nothing.** One bad row stops the whole file. Fix it and send it again.
- **Never overwrites.** A row with the same kind, symbol, venue and start date that already exists is left alone. To change numbers, add new rows with a later `EffectiveFromUtc`; the latest one in force wins.
- At most 5,000 rows per file.

> [!TIP] Re-import on a schedule
> Exchanges change margins often, and CME raises them quickly when markets get wild. Re-read the venue's pages regularly (at least monthly, and after big market moves) and import the new numbers with that day's date.

## Fee schedules

A **fee schedule** says what a venue charges per trade: exchange and clearing fees, regulatory fees, broker commission. Backtests use it to price futures, crypto and stock trades, and the venue order ticket uses it to show the fee before you send. Forex costs still come from your broker.

Open **Configuration → Fee Schedules** (`/reference/fee-schedules`).

![Fee schedules: ((1)) the fees in a row, ((2)) where they came from, ((3)) add a row](ma-fees "/reference/fee-schedules")

Each row shows its fees ((1)) and its **Source** ((2)). The source says whether the numbers were checked:

- Rows checked against the venue's own page on 27 October 2026 cite that page and date. This includes the US stock fees (SEC fee $20.60 per million, FINRA trading activity fee), the NFA fee on US futures, and the Eurex FDAX and FESX exchange fees.
- Rows marked **"engine starting value … NOT a quote"** were not checked. Most crypto rows and the CME and ICE commission and exchange parts are like this.

To check a row against the venue:

1. Open the venue's published fee page (the link is in **Source**).
2. Compare the base (lowest-volume) tier with the row's fees.
3. If they differ, do not edit the old row. Set its **Until** date to the day the fees changed, then {{Add a row}} ((3)) with the new fees, **In force from** that same day, and the page address and date in **Source**.

> [!NOTE]
> Changing a fee changes how every symbol it prices is costed. Backtests priced with the old fee stop counting as evidence for promoting a strategy and are re-run. This only matters once `Research:MultiAsset` is on.

## Symbol matching (instrument mappings)

Each venue has its own name and units for the same thing. Lascodia calls Bitcoin's perpetual future `BTC-USDT-PERP`; Binance calls it `BTCUSDT`, and OKX counts it in contracts of 0.01 BTC. An **instrument mapping** records, per venue, the venue's symbol, its contract size, its quantity step and its tick size.

```stack
Engine symbol | BTC-USDT-PERP, in coins | coins
-> instrument mapping for the venue
Venue symbol | BTCUSDT, or contracts of a set size | arrow-left-right
-> fills come back as
Matched fill | Booked to the right position | circle-check-big
@caption Without the mapping, the last step fails: the fill is recorded as "unmatched" and nothing is booked.
```

Mappings are made by the daily instrument download, not by hand. There is no page to edit them. Every account at a venue shares that venue's mappings.

- **No mapping, no trade.** New trades are only sent for symbols that have a mapping at the account's venue.
- **No mapping, no booking.** A fill for a symbol with no mapping is recorded as **unmatched**. That is the safe direction (nothing wrong is booked), but the position will not appear in Lascodia.

On 28 October 2026 there were mappings for `binance`, `binance-usdm`, `bybit`, `bybit-linear`, `coinbase`, `kraken`, `okx` and `okx-swap`. None yet for `kraken-futures`, or for any futures or stock broker (their sources need vendor keys). Staff with database access can count them:

```sql
-- read-only: mappings per venue
SELECT "Venue", count(*) FROM "InstrumentVenueMapping" WHERE "IsDeleted" = false GROUP BY 1 ORDER BY 1;
```

> [!WARNING]
> Before you activate an account at a venue, check that the venue has mappings for the symbols you plan to trade.

## Instrument candles

Forex candles come from the EA. Futures, crypto and stock candles are built by the engine from the trades it stores. The **Instrument Candles** page (**Trading → Instrument Candles**, `/market-data/instrument-candles`) shows how far that builder has got.

![Instrument candles: ((1)) the builder switch, ((2)) one row per symbol, ((3)) continuous futures rolls](ma-candles "/market-data/instrument-candles")

- **builder off / on** ((1)) shows `MarketData:InstrumentCandles:Enabled`.
- **Symbols** ((2)): each symbol's single source, the period built, how far behind live it is (**Lag**), and a status. :ok[Live] is up to date. :bad[Stalled] has stopped moving. :bad[Blocked] means another source already owns that symbol's candles.
- **Continuous futures rolls** ((3)): a **continuous** series such as `ES1!` joins one contract to the next at each expiry. The page lists every roll and the prices used to join them. `ES1!` is adjusted so the join has no jump (the **Panama** method); `ES1!U` is the raw, unadjusted series.

> [!TIP]
> Turn the builder on only after a futures, crypto or stock data source is storing trades. With no stored trades, there is nothing to build.

## Rolling out safely

Never switch a venue straight to full live trading. Go up one rung at a time, and only move up after the rung below has worked for long enough to trust it.

```flow
Testnet / paper | Real venue code, practice money | flask-conical
Shadow | Live account, read only, no orders | eye
Capped live | Real money, small exposure cap | gauge
Normal | Usual risk limits | circle-check-big
@caption Each rung is a separate decision. Write down why you moved up.
```

**1. Testnet / paper.** On **Connections**, {{Add account}} with **Mode** set to **Paper (testnet)**: it uses the venue's practice endpoint. Store its key, verify it, activate it, then turn the switches on in the order above, including entries. Trade small amounts and check fills, stops and closes. The [Connect a broker or exchange](/docs/connections-guide) guide covers the account and key steps.

**2. Shadow.** Turn `Execution:Entries:Enabled` back off. Add and activate the **Live** account. With `Execution:Reconciliation:Enabled` on and the mode left at `report`, the engine reads the live account's positions and open orders every minute and compares them with its own, but sends nothing. Watch **Connections → Reconciliation drift** for several days.

![Reconciliation drift: differences between the engine and each venue account appear here](ma-drift "/connections/drift")

**3. Capped live.** Set a small exposure cap for the asset class, `Risk:MultiAsset:Caps:AssetClass:<class>:MaxExposurePct` (for example `Crypto`), as a percentage of account equity. If the account's **Organisation → Settings** list shows this key, set it there, for that account only (see the tip under [Where the switches live](/docs/multi-asset-setup#where-the-switches-live)). If it does not, set it on the **Config** page instead: there it applies to every account. Then turn `Execution:Entries:Enabled` on again.

**4. Normal.** Raise the cap step by step, or set it back to `0` (off). Raising a cap loosens risk, so each step waits out the 24-hour cooling-off.

> [!DANGER] Entries is one switch for the whole platform
> While `Execution:Entries:Enabled` is on, every active venue account can receive new trades, live ones included. Keep it off while a live account is only meant to be watched.

> [!NOTE]
> Manual orders on a real-money account also need the platform's manual live-trading settings (`ManualTrading:LiveEnabled`, and `ManualTrading:LiveOnRealAccounts` for Real accounts).

## Network: crypto exchanges and DNS

**DNS** is the internet's address book: it turns a name like `api.binance.com` into a numeric address. The office router's DNS answers "no such name" for every crypto exchange (Binance, Bybit, OKX, Kraken, Coinbase). Because of that, the engine's containers are set to use public DNS servers instead: **1.1.1.1** (Cloudflare) and **9.9.9.9** (Quad9). They are the defaults of `ENGINE_DNS_PRIMARY` and `ENGINE_DNS_SECONDARY` in the engine's `.env` file. The host computer and the router are not changed.

If crypto calls fail with name errors (messages such as `NXDOMAIN`, `ENOTFOUND` or "name or service not known"):

1. Check the container still has the public servers:

   ```bash
   docker inspect --format '{{.HostConfig.Dns}}' lascodia-trading-engine-api-1   # expect [1.1.1.1 9.9.9.9]
   ```

2. Check a name resolves from inside the container:

   ```bash
   docker exec lascodia-trading-engine-api-1 getent hosts api.binance.com
   ```

3. If step 1 shows `[]`, the container was created without the setting (for example from an old compose file). Recreate it from the current compose file.
4. If step 2 fails but step 1 is right, the network itself may be blocking those servers. Try other public servers through `ENGINE_DNS_PRIMARY` / `ENGINE_DNS_SECONDARY`, then recreate the containers.

## If something goes wrong

```decide
Is an exchange-traded trade being refused by the risk check?
Yes: Read the refusal. "No margin requirement" means load margins for that symbol and venue. A session, expiry, funding or day-trading refusal is the check doing its job.
No: If nothing reaches the venue at all, check the switches on Connections: Router and Entries must both be true.
Not sure: Open the signal on Trade Signals and read its rejection reason.
```

?? Every futures order is refused with a margin message.
   No CME margins are loaded yet. Add them on **Margin Requirements** or import them from a file (see [Importing many rows from a file](/docs/multi-asset-setup#importing-many-rows-from-a-file)). Remember a root row such as `ES` covers all its contracts.

?? A trade filled at the venue but no position appeared in Lascodia.
   The fill was probably recorded as **unmatched** because the symbol has no mapping at that venue. Check the mappings (see [Symbol matching](/docs/multi-asset-setup#symbol-matching-instrument-mappings)) and that the venue's instrument download is switched on.

?? I changed a switch but nothing happened.
   Check the **Save** message. A risk-loosening change is **queued for cooling-off** and only applies after 24 hours. A **Cold** setting needs an engine restart.

?? The import was refused with errors.
   Nothing was saved: the file is all or nothing. Fix the rows named in `errors`, run the dry run again, then import.

?? Crypto prices or orders fail with "name not found" errors.
   Follow the checks in [Network: crypto exchanges and DNS](/docs/multi-asset-setup#network-crypto-exchanges-and-dns).

?? The Instrument Candles page shows a symbol as Blocked.
   Another source already owns that symbol's candles. Each symbol has exactly one source, so pick the one you trust and leave the other alone.

## Where to next

```cards
cable | Connect a broker or exchange | Add a venue account, store its keys, test it | /docs/connections-guide
server | Platform operator guide | Organisations, data sources, fleet health | /docs/platform-guide
satellite | Data feeds and integrations | CME depth, FIX venues, webhooks, tokens | /docs/integrations
book-open | Words explained | Margin, leverage, fills and more | /docs/glossary
```

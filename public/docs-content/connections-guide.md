# Connect a broker or exchange

> [!SUMMARY]
> Besides MetaTrader 5, Lascodia can trade futures, crypto and stocks through brokers and exchanges directly. Each link is a **connection** on the **Connections** page.
> You add the account, store a trade-only API key, let Lascodia verify it, and then switch the account on. Start with practice (paper) accounts; real money comes later.

```flow
Add the account | It starts switched off | link
Store the key | A trade-only API key, entered once | key-round
Verify | Lascodia signs in and checks the key | shield-check
Activate | Lascodia may now send orders there | power
@caption The four steps for every broker or exchange. Nothing is sent to the venue until the last one.
```

## What a connection is

A **venue** is any place that carries out trades: a futures broker, a crypto exchange or a stock broker. A **connection** (the page calls it an **execution account**) links one of your accounts at a venue to Lascodia, so Lascodia can place orders there for you.

```stack
Lascodia engine | Decides and checks every order against your limits | shield-check
-> sends the order through
Adapter | Lascodia's built-in translator for one venue | puzzle
-> signs in with your API key at
Venue | Your broker or exchange, where your money stays | landmark
@caption Lascodia talks to each venue through an adapter, using a key you give it. Your money never leaves the venue.
```

Which venues Lascodia can talk to:

| Kind of venue | Adapters on the page |
| --- | --- |
| Futures brokers | `rithmic`, `cqg`, `tradovate`, `ib` (Interactive Brokers) |
| Crypto exchanges | `binance`, `binance-usdm` (Binance USD-M futures), `coinbase`, `kraken`, `kraken-futures`, `bybit-spot`, `bybit-linear`, `okx`, `okx-swap` |
| Stock brokers | `alpaca`, `tradier`, `ib` (Interactive Brokers) |

> [!NOTE] MetaTrader 5 accounts are not listed here
> A MetaTrader 5 account trades through its Lascodia EA, so it needs no connection on this page. To link one, follow [Connect MetaTrader 5](/docs/ea-install).

> [!NOTE] These markets are switched on by the platform team
> Futures, crypto and stock trading is off until the platform team turns it on. Until then you can still add accounts and verify keys, but no order is sent. The platform team's steps are in [Switching on futures, crypto and stocks](/docs/multi-asset-setup).

## The Connections page

Open **Configuration → Connections** in the sidebar.

![The Connections page: ((1)) add an account, ((2)) the platform's on/off switches, ((3)) your accounts at venues, ((4)) the adapters Lascodia has](conn-overview "/connections")

- {{Add account}} ((1)) starts a new connection.
- **Execution switches (platform)** ((2)) shows the platform team's switches. You cannot change them here.
- **Execution accounts** ((3)) lists your connections, their key and their health.
- **Adapters in this build** ((4)) lists every venue Lascodia can talk to, and what each supports.

You will need the right permissions:

| To do this | Permission | Roles that have it |
| --- | --- | --- |
| See the page | read accounts | Every role, from Viewer up |
| Add, activate or disable an account | manage accounts | Operator, Admin, Owner |
| Store, verify or revoke a key | connect accounts | Operator, Admin, Owner |

### The platform switches

![The platform switches. A green chip means the switch is on](conn-switches "/connections")

| Switch | When it is on |
| --- | --- |
| **Router** | Lascodia may send orders to venues at all. While it is off, nothing is routed. |
| **Entries** | Lascodia may open new trades at venues. |
| **Fills** | Lascodia reads back what was filled (carried out). |
| **Protection** | Lascodia places protective orders (stop loss, take profit) at the venue. |
| **Reconciliation** | Lascodia compares its records with the venue's (see [Check for differences](/docs/connections-guide#check-for-differences)). |
| **Trailing** | Lascodia moves stop losses as the price moves in your favour. |

> [!TIP]
> If everything shows `false`, the platform team has not switched these markets on yet. Ask them before you wonder why nothing trades.

## Step 1 — Add the account

1. Click {{Add account}}.
2. Type a **Name** you will recognise ((1)), for example "Binance practice".
3. Choose the **Adapter** ((2)): the venue's adapter from the table above.
4. Type the **Venue** ((3)) in lower case, for example `binance` or `cme`.
5. Leave **Mode** ((4)) on **Paper (testnet)** for your first connection.
6. Optional: the **Venue account id** (your account number at the venue), a **Linked trading account id** (an account in Lascodia to attach this one to), and the **Account currency**.
7. Click {{Add (disabled)}} ((5)).

![Adding an account: ((1)) name, ((2)) adapter, ((3)) venue, ((4)) paper or live, ((5)) add it switched off](conn-add "/connections")

> [!SUCCESS]
> The account appears under **Execution accounts** with the state :muted[Disabled] and **No credential**. Disabled means nothing is sent to the venue yet.

### Paper or live?

```decide
Is this your first connection to this venue?
Yes: Choose Paper (testnet). Lascodia then uses the venue's practice service, with pretend money.
No, I have tested it on paper and want real trades: Choose Live. Once activated, orders trade real money.
Not sure: Choose Paper. You can add a Live account later.
```

**Paper** sends orders to the venue's practice service, often called a *testnet*, *sandbox* or *demo*. You need a separate practice account (and key) at the venue for it.

| Venue | Its practice service |
| --- | --- |
| Binance, Binance USD-M | Binance testnet |
| Bybit spot and linear | Bybit testnet |
| OKX, OKX swap | OKX demo trading |
| Coinbase | Coinbase Advanced Trade sandbox |
| Kraken Futures | Kraken demo futures |
| Kraken (spot) | **None.** Kraken has no practice service, so the platform team must set it up for live use deliberately |
| Rithmic | Rithmic Test |
| CQG | CQG demo server |
| Tradovate | Tradovate demo |
| Interactive Brokers | IB's paper account, through a gateway the platform team runs |
| Alpaca | Alpaca paper trading |
| Tradier | Tradier sandbox |

> [!DANGER] Live means real money
> With **Live**, every order Lascodia routes to this account trades real money once it is activated. The page warns you when you choose it. Test on Paper first.

## Step 2 — Store a trade-only API key

An **API key** is a password made for programs. You create it on the venue's website and give it to Lascodia, so Lascodia can trade on your account without your own sign-in. Most venues give two parts:

- the **API key** (or key id): like a user name, safe to recognise;
- the **API secret**: like a password, shown by the venue only once.

### Make the key safe at the venue first

When you create the key on the venue's website:

- [ ] Allow **trading** (placing and cancelling orders) and **reading** (balances and positions).
- [ ] **Disable withdrawals.** Never tick "withdraw", "transfer" or "move funds".
- [ ] If the venue offers an **IP allow-list** (a list of internet addresses allowed to use the key), use it. Ask the platform team which address Lascodia connects from.
- [ ] For Paper, create the key on the venue's practice service, not on your real account.

> [!DANGER] Never give Lascodia a key that can withdraw
> A key that can withdraw or transfer could move money out of your account if it ever leaked. Lascodia checks this: a key that can withdraw or transfer is **refused and erased** at verification. Create a trade-only key instead.

### Enter the key

1. On the account's row, click {{Add key}} (or {{Replace key}} if one is stored).
2. A **Credential** form opens with the fields that venue needs (see the table). Paste each value.
3. Click {{Save credential}}.

| Venue | Fields the form asks for |
| --- | --- |
| Binance, Binance USD-M | API key, API secret, and optionally an Ed25519 private key (PEM) |
| Bybit, Kraken, Kraken Futures, Alpaca | API key, API secret |
| OKX, OKX swap | API key, API secret, Passphrase |
| Coinbase | Key name (`organizations/…/apiKeys/…`), Private key (EC PEM) |
| Tradovate | User name, Password, App id (cid), App secret |
| Rithmic, CQG | User name, Password |
| Interactive Brokers | Client Portal access token |
| Tradier | Access token |

> [!NOTE] Write-only
> The values go to Lascodia once. They are stored encrypted, never shown again and never written to logs. The form clears itself as soon as you click {{Save credential}}. Afterwards the page only shows a **fingerprint**: the first 4 and last 4 characters of the key id, so you can tell keys apart.

> [!SUCCESS]
> A message says "Credential stored. Verify it next." The **Credential** column shows :warn[Saved, not verified] and the fingerprint.

## Step 3 — Verify the key

Verifying makes Lascodia sign in at the venue with your key and record what the key may do. It places no order.

1. On the account's row, click {{Verify}}.
2. Read the message. It names the venue and whether it is the practice (testnet / paper) or LIVE service.
3. Click {{Verify}} again to confirm.

> [!SUCCESS]
> The **Credential** column shows :ok[Verified]. A box above the list shows the fingerprint and the permissions the venue reported.

| Credential status | What it means | What to do |
| --- | --- | --- |
| :muted[No credential] | No key stored | Click {{Add key}} |
| :warn[Saved, not verified] | Stored, not checked yet | Click {{Verify}} |
| :ok[Verified] | Lascodia signed in and the key is trade-only | Activate the account |
| :bad[Refused: the key can withdraw or transfer] | The key could move money, so Lascodia erased it | Create a new trade-only key at the venue and store it |
| :bad[Rejected by the venue] | The venue did not accept the key | Check you copied it fully, and that it belongs to the right service (practice or live) |
| :muted[Revoked] | You erased the key | Store a new key to use the account again |

## Step 4 — Activate the account

1. On the account's row, click {{Activate}}.
2. Read the message and click {{Activate}}.

Lascodia refuses to activate an account without a verified key. Once active, and with the platform's **Router** switch on, Lascodia sends this account's orders to the venue.

> [!WARNING]
> For a **Live** account, activating means real-money trades from that moment. Check your [risk limits](/docs/admin-guide#risk-and-kill-switches) first.

To pause an account, click {{Disable}}. Lascodia stops sending orders to it. Open positions stay at the venue.

## Read the account's health

The **Execution accounts** list shows, for each account:

| Column | What it tells you |
| --- | --- |
| **State** | :ok[Active], :muted[Disabled] or :warn[Suspended], with the mode (Paper or Live) underneath |
| **Credential** | The key's status and fingerprint (see Step 3) |
| **Health** | One word, plus any problems (below) |
| **Outbox 24 h** | How many orders Lascodia sent, or tried to send, in the last 24 hours, by outcome |
| **Last fill** | When the venue last carried out an order, and how many in 24 hours |

| Health | Meaning |
| --- | --- |
| :ok[ok] | Active, verified, and orders or fills went through in the last 24 hours |
| :muted[idle] | Active and verified, but nothing traded in the last 24 hours |
| :bad[attention] | Something needs a look. The problems are listed underneath |
| :warn[off] | The account is not active |

Problems Lascodia lists under :bad[attention]:

- "No credential stored." or "Credential is …": store or verify a key.
- "An instruction has waited N s to be sent.": an order is stuck for more than two minutes. Check the platform switches and the venue's status.
- "N instruction(s) failed or expired in 24 h.": some orders did not get through. The row shows the last failure.
- "N protective leg(s) failed.": a stop loss or take profit could not be placed at the venue. Check the position at the venue now.

## Check for differences

**Reconciliation** means comparing Lascodia's record of positions and orders with what the venue reports. Click {{Reconciliation drift}} at the top of the Connections page.

![Reconciliation drift: differences between Lascodia and each venue, read-only](conn-drift "/connections/drift")

- Nothing appears until the platform team turns on the **Reconciliation** switch.
- In the default **report** mode, differences are only shown, never fixed automatically.
- MetaTrader 5 accounts are always report-only.

## Rotate or remove a key

It is good practice to replace keys from time to time, and at once if one may have leaked.

**To rotate a key:**

1. Create a new trade-only key at the venue.
2. On the account's row, click {{Replace key}}, paste the new values and click {{Save credential}}.
3. Click {{Verify}}.
4. Delete the old key on the venue's website.

**To remove a key:**

1. On the account's row, click {{Revoke}}.
2. Click {{Revoke}} to confirm.

> [!WARNING]
> Revoking erases the stored key **and disables the account**. Nothing more is sent to the venue for it. Open positions stay at the venue: manage them there. Also delete the key on the venue's website.

## Market names (symbol mapping)

Each venue names the same market differently. Bitcoin against the US dollar might be `BTCUSDT` on Binance and `BTC-USDT-SWAP` on OKX. Lascodia uses one name for each market, and keeps a matching table that turns it into each venue's own name, with the venue's size steps and contract sizes.

```flow
Lascodia's name | One name per market | compass
Matching table | Kept by the platform team | layers
Venue's name | BTCUSDT, BTC-USDT-SWAP, … | landmark
@caption You never type venue names. If a market is missing at your venue, ask the platform team to add it.
```

## Look at what each adapter supports

![Adapters in this build: ((1)) the adapter's name, ((2)) whether stops live at the venue, ((3)) the unit you trade in](conn-adapters "/connections")

| Column | In plain words |
| --- | --- |
| **Kind** ((1)) | The adapter's name, and whether it needs a key |
| **Order types** | Market (now, at the best price), Limit (only at your price or better), Stop and StopLimit (triggered when the price reaches a level) |
| **Time in force** | How long an order waits: Day, Gtc (until cancelled), Ioc (fill what you can now, cancel the rest), Fok (all now or nothing) |
| **Stops at venue** ((2)) | `yes`: the stop loss sits at the venue. `engine-held`: Lascodia watches the price and sends the close itself |
| **Positions** | `netting`: one position per market, so buys and sells offset each other. `both` (MetaTrader 5 only): netting or separate positions, depending on the account |
| **Unit** ((3)) | What quantities are counted in: Shares, Coins, Contracts or Lots |

## If something goes wrong

```decide
Does the account show State Active, Credential Verified and Health ok or idle?
Yes: The connection works. If no orders arrive, check the platform switches: Router and Entries must be on.
No, Credential is not Verified: Store a trade-only key and click Verify. Read the status table in Step 3.
No, State is Disabled: Click Activate. It needs a verified key.
No, Health says attention: Read the problems listed under it.
```

?? Verification says "Refused: the key can withdraw or transfer".
   The key has withdrawal or transfer rights, so Lascodia erased it. At the venue, create a new key with trading only, and withdrawals and transfers turned off. Store it with {{Add key}} and verify again.

?? Verification says "Rejected by the venue".
   The venue did not accept the key. Check you pasted every character (PEM keys are several lines long). Check the key was made on the right service: a Paper account needs a key from the venue's practice service, a Live account a real one. Check the key has not expired, and that an IP allow-list at the venue includes Lascodia's address.

?? {{Activate}} is refused.
   Lascodia only activates an account with a **Verified** key. Verify first.

?? The account is Active but no orders go out.
   Look at **Execution switches (platform)**. While **Router** or **Entries** is `false`, nothing is sent. The platform team controls these.

?? I cannot see {{Add account}} or {{Add key}}.
   Your role lacks the permission. Adding accounts needs *manage accounts*; keys need *connect accounts*. Ask an Admin or Owner.

?? Health says a protective leg failed.
   A stop loss or take profit could not be placed at the venue. Open the venue's own website or app and check the position now. Then look at the row's last failure for the reason.

?? Kraken (spot) does not work on Paper.
   Kraken has no practice service. The platform team must set Kraken up for live use deliberately.

## Where to next

```cards
plug | Connect MetaTrader 5 | Link a MetaTrader 5 account through the Lascodia EA | /docs/ea-install
layers | Switching on futures, crypto and stocks | For the platform team: margins, fees and the switches | /docs/multi-asset-setup
building | Running your organisation | Roles, risk limits and kill switches | /docs/admin-guide
shopping-cart | Placing trades | Practise on paper, then trade for real | /docs/trading-guide
```

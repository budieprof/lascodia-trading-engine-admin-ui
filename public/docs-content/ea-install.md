# Connect MetaTrader 5

> [!SUMMARY]
> This guide links a MetaTrader 5 trading account to Lascodia. You download a small add-on (the Lascodia EA), create a one-time key for it, set it up in MetaTrader 5, and wait for the console page to turn green.
> It takes about ten minutes. Every message the page can show is explained at the end, with the fix.

```flow
Download the EA | One file from the console | download
Create a token | A one-time key for this terminal | key-round
Allow the address | One line in MetaTrader 5's options | shield-check
Attach the EA | Drag it onto a chart, load the preset | mouse-pointer-click
Wait for green | The page confirms the link | circle-check-big
@caption The five steps. The Guided connection page walks you through all of them.
```

## What you are connecting

**MetaTrader 5** (often shortened to MT5) is the trading program your broker gives you. It runs on your own computer or on a server. A **terminal** is one copy of MetaTrader 5, signed in to one trading account.

The **Lascodia EA** is a small add-on that runs inside MetaTrader 5. EA stands for *Expert Advisor*, MetaTrader's name for an add-on program. Once attached, it sends prices and your account details to Lascodia, and places the trades Lascodia asks for.

```stack
Lascodia console | You watch and control everything here | monitor
-> sends instructions to
Lascodia engine | Checks every trade against your limits | shield-check
-> talks over the internet to
Lascodia EA inside MetaTrader 5 | On your computer or a server | laptop
-> places trades with
Your broker | Where your money stays | landmark
@caption The EA is the bridge between Lascodia and your broker. Your money never leaves your broker.
```

Each terminal gets its **own credential**: a private sign-in that only that terminal holds. You give the terminal a one-time **enrollment token** once. The EA swaps it for its credential and from then on signs in by itself. If you later stop trusting a terminal, you switch off just that one.

> [!NOTE] Demo accounts first
> New organisations can connect MetaTrader 5 **demo** accounts only. A demo account trades with pretend money. When this rule applies to you, the Guided connection page says so in its first part.

## Open the Guided connection page

Everything starts on one page. Open **Organisation → Connect a terminal** in the sidebar, then click {{Guided connection}}. You can also go straight to [the Guided connection page](/organisation/terminals/connect).

![The Guided connection page has four parts: ((1)) what you need, ((2)) the one-time token, ((3)) the MetaTrader 5 steps, ((4)) the live progress](ea-wizard "/organisation/terminals/connect")

You will need:

- [ ] MetaTrader 5 installed on Windows (or on a Mac or Linux computer through Wine, a tool that runs Windows programs).
- [ ] MetaTrader 5 signed in to the broker account you want to connect.
- [ ] A role with the **connect accounts** permission. The Owner, Admin and Operator roles have it.
- [ ] Your phone with your authenticator app, in case the console asks you to confirm your second factor.

> [!TIP]
> Keep the Guided connection page open in your browser while you work in MetaTrader 5. Part 4 updates by itself every few seconds.

## Step 1 — Download the EA

The EA is one file called `LascodiaEA.ex5`. You download it from the console while signed in. There is no public link.

1. In part **1 Before you start**, click {{Download the EA (LascodiaEA.ex5)}} ((1)).
2. Your browser saves the file, usually in your *Downloads* folder.
3. Look at the facts under the button ((2)): the version, when it was published, its size and its **SHA-256**. The SHA-256 is a fingerprint of the file. The console checks the download against it for you, and refuses to save a file that does not match.
4. Note the **engine address** ((3)). This is the internet address the EA will call. You need it in Step 3.

![Part 1: ((1)) the download button, ((2)) the file's version and fingerprint, ((3)) the engine address for your organisation](ea-download "/organisation/terminals/connect")

> [!SUCCESS]
> A green message says the EA was downloaded and its SHA-256 was checked.

> [!NOTE]
> Instead of the button you may see a plain **Download the EA** link, or the words "Ask your platform contact for the EA file". It depends on how the platform team publishes the EA. The EA must be version **8.47.253 or later**: older versions cannot use a token.

## Step 2 — Create the enrollment token

The **enrollment token** is a one-time key. It lets one terminal join your organisation, once. The console shows it **only once**, so be ready to copy it or download the preset.

1. In part **2 Create the enrollment token**, type a name under **Name this terminal** ((1)). Pick a name you will recognise later, for example "Office PC — EURUSD chart".
2. Optional: under **Broker login** ((2)), type the account number of the MetaTrader 5 account. Then no other account can use this token. When you fill it in, a **Broker server** box appears. Type the server name exactly as MetaTrader 5 shows it (for example in **File → Login to Trade Account**).
3. Click {{Create token}} ((3)). If the console asks you to confirm your second factor, do so. It then offers to finish what you started.

   ![Part 2: ((1)) name the terminal, ((2)) optionally lock the token to one broker login, ((3)) create the token](ea-token "/organisation/terminals/connect")
4. The token appears. It starts with `lsc_enr_`. Click {{Download the MT5 preset (.set)}}. A **preset** is a small settings file MetaTrader 5 can load, so you do not have to type anything. This one holds the engine address and the token.

> [!WARNING] The token is shown once
> Copy the token or download the preset **before** you close the box. The token works for **one terminal, once**, and expires after **24 hours** (the page shows the exact time). If you lose it, simply create a new one.

> [!TIP] Treat the token like a password
> Anyone holding it can connect a terminal to your organisation until it is used or expires. Do not paste it into chats or e-mails. Delete the preset file once the terminal is connected.

## Step 3 — Set up MetaTrader 5

These steps happen inside MetaTrader 5, so this guide describes them in words. Part **3 Set up MetaTrader 5** of the Guided connection page repeats them, with your own engine address filled in.

![Part 3 on the console: ((1)) the address to allow, ((2)) where to copy the EA, ((3)) the two inputs if you set them by hand, ((4)) the final check](ea-mt5-steps "/organisation/terminals/connect")

### 3a — Allow the EA to reach Lascodia

MetaTrader 5 blocks add-ons from calling internet addresses unless you list them first. This list is the **WebRequest allow-list**.

1. In MetaTrader 5, open **Tools → Options**.
2. Choose the **Expert Advisors** tab.
3. Tick **Allow WebRequest for listed URL**.
4. Double-click the empty line under it and type the address from the console ((1)). It is only the start of the engine address, for example `https://app.example.com`. Leave out everything after the host name.
5. Click {{OK}}.

> [!WARNING]
> Skip this and nothing ever reaches Lascodia. The EA's log in MetaTrader 5 then shows **error 4060** (or **4014**, depending on the MetaTrader 5 version), and the console keeps waiting.

### 3b — Copy the EA into MetaTrader 5

1. In MetaTrader 5, open **File → Open Data Folder**. A file window opens.
2. Open the folder **MQL5**, then **Experts**.
3. Copy `LascodiaEA.ex5` from your *Downloads* folder into **Experts** ((2)).
4. Back in MetaTrader 5, open the **Navigator** panel (**View → Navigator**, or [[Ctrl]] + [[N]]).
5. Right-click **Expert Advisors** and choose **Refresh**. **LascodiaEA** now appears in the list.

```flow
File → Open Data Folder | MetaTrader 5 opens its own folder | settings
MQL5 → Experts | Paste LascodiaEA.ex5 here | download
Navigator → Refresh | Right-click Expert Advisors | refresh-cw
@caption Copying the EA. Refresh makes MetaTrader 5 notice the new file.
```

### 3c — Attach the EA to a chart and load the preset

1. Open any chart, for example **EURUSD** (**File → New Chart**).
2. Drag **LascodiaEA** from the Navigator onto the chart. A settings window opens.
3. On the **Common** tab, tick **Allow Algo Trading**. "Algo trading" means letting an add-on place trades.
4. On the **Inputs** tab, click {{Load}} and choose the `.set` preset you downloaded in Step 2.
   - No preset? Set the two inputs by hand instead ((3)): `InpEngineBaseUrl` is the full engine address, and `InpEnrollmentToken` is the token.
5. Click {{OK}}.
6. On MetaTrader 5's top toolbar, make sure the **Algo Trading** button is **green** ((4)). Click it if it is not.

| Input in MetaTrader 5 | What to put there |
| --- | --- |
| `InpEngineBaseUrl` | The full engine address from the console, ending in `/api/v1/lascodia-trading-engine` |
| `InpEnrollmentToken` | The token from Step 2 (it starts with `lsc_enr_`) |
| `InpSymbols` | Optional. Which markets this EA looks after: `CHART` (just the chart's market), a list such as `EURUSD,GBPUSD`, or `ALL` |
| `InpBrokerSymbolSuffix` / `InpBrokerSymbolPrefix` | Optional. Only when your broker adds letters to market names, for example `EURUSDm` (suffix `m`) |
| `InpSymbolMapping` | Optional. Single name pairs, broker name first, for example `XAUUSD.spot=XAUUSD` |

> [!SUCCESS]
> The EA's status panel appears on the chart. Within seconds, part 4 of the console page starts ticking off steps.

> [!TIP]
> Once connected, delete the `.set` preset file. The token inside is used up, and the EA keeps its own credential safely in MetaTrader 5's data folder.

## Step 4 — Wait for the page to turn green

Part **4 Waiting for your terminal** follows your token. It reads the engine's view every few seconds. Click {{Check now}} to read it at once.

![Part 4 before a token exists. After Step 2 it lists the steps below and ticks them off](ea-waiting "/organisation/terminals/connect")

The terminal moves through five steps. Each turns into a green dot when it is done:

```flow
Token created | Valid until the time shown, single use | key-round
Credential issued | The EA swapped the token for its own sign-in | lock-keyhole
Signed in | The EA signed in with its credential | log-in
Registered | The EA told Lascodia which markets it covers | list-checks
Heartbeat received | The EA checks in every 30 seconds | heart-pulse
@caption The steps on the page, in order.
```

| What the headline says | What it means | What to do |
| --- | --- | --- |
| :info[waiting-for-terminal] Waiting for the terminal to use the token… | Nothing has arrived from MetaTrader 5 yet | Finish Step 3. Most often the allow-list (3a) is missing |
| :info[enrolled] The terminal has its credential; waiting for it to sign in… | The token worked | Wait a few seconds |
| :info[signed-in] Signed in; waiting for the EA to register… | The EA is in | Wait. If it stays here, check the market names (see the questions below) |
| :info[registered] Registered; waiting for the first heartbeat… | Almost done | Wait up to a minute |
| :ok[connected] Connected — the terminal is sending heartbeats. | It works | Nothing. Open a live chart |
| :warn[stale] The terminal stopped sending heartbeats. | MetaTrader 5 closed, slept or went offline | Start MetaTrader 5 again and keep it online |
| :bad[refused] The engine turned the terminal away. | The account is not allowed (the reason is shown) | Fix the reason. The same token still works |
| :bad[token-expired] The token expired before a terminal used it. | More than 24 hours passed | Create a new token |
| :bad[token-revoked] The token was revoked. | Someone cancelled it | Create a new token |
| :bad[credential-revoked] This terminal's credential was revoked. | Someone switched this terminal off | Create a new token and connect again |

> [!SUCCESS] Connected
> A green box names the terminal, the broker account and server, the account type (for example Demo), the EA version and how many seconds ago the last heartbeat came. Click {{Open a live chart}} or {{Back to Get started}}.

Under the steps, the page lists hints headed **If it does not move**. A hint with an amber edge is something the engine sees happening **right now**. The plain ones are general checks.

### What the EA is doing

Once connected, the green box also shows the EA's own state:

| State | In plain words |
| --- | --- |
| RUNNING | Working normally. |
| MARKET_CLOSED | The market is closed (for example at the weekend). It wakes up by itself. |
| BROKER_DISCONNECTED | MetaTrader 5 lost its link to the broker. Check MetaTrader 5's internet connection. |
| SAFE_MODE | The EA paused new trades after a problem it expects to clear. It usually recovers by itself. |
| SAFETY_STOP | A safety limit stopped new trades. Existing trades keep their protective stops. Some causes clear by themselves; others need a person to look. |

## Look after your terminals

The **Connect a terminal** page (**Organisation → Connect a terminal**) lists every token and every connected terminal in your organisation.

![The Connect a terminal page: ((1)) open the guided connection, ((2)) create a token here instead, ((3)) tokens waiting to be used, ((4)) every connected terminal](ea-terminals "/organisation/terminals")

- **New enrollment token** ((2)) does the same as Step 2, with more choices: an EA on a chart, or a **supervisor daemon** (a helper program that starts terminals on a server by itself), and which account the token may connect.
- **Enrollment tokens** ((3)) lists tokens not used yet. Tick **Show used, expired and revoked** to see the rest. {{Follow}} opens the Guided connection page for that token.
- **Machine credentials** ((4)) lists every terminal that holds a credential, grouped by trading account.

### Read the Machine credentials list

![Machine credentials: ((1)) when the terminal last used its credential, ((2)) its state, ((3)) give it a new secret, ((4)) switch it off](ea-credentials "/organisation/terminals")

| State | Meaning |
| --- | --- |
| :ok[Active] | The terminal is using its credential. |
| :warn[Not used yet] | The credential exists, but the terminal has not signed in with it yet. |
| :info[Rotation requested] | You asked for a new secret. The terminal gets it at its next sign-in. |
| :info[New secret handed out] | The terminal has its new secret. The old one stops once the new one is used. |
| :bad[Revoked] | Switched off. The terminal is refused. |

**Last used** ((1)) is updated every few minutes, so a short delay is normal. A chip :warn[update available] next to a terminal means a newer EA has been published. Download it (Step 1), copy it over the old file in **MQL5 → Experts**, and attach the EA to the chart again.

### Give a terminal a new secret (rotate)

Rotating is good hygiene, for example every few months. The terminal keeps working.

1. Click {{Rotate}} ((3)) on the terminal's row.
2. Confirm with {{Rotate}}. The terminal receives a new secret at its next sign-in, within 15 minutes.

### Switch a terminal off (revoke)

Revoke a terminal you no longer use, or one you think someone else may control.

1. Click {{Revoke}} ((4)) on the terminal's row.
2. Optional: type a **Reason**. It is kept in the audit log.
3. Click {{Revoke credential}}.

![Revoking asks you to confirm, with a box for the reason](ea-revoke-dialog "/organisation/terminals")

> [!WARNING]
> The terminal is refused within **30 seconds**. It stops receiving signals and sending reports. Its **open positions stay open with your broker**, so close them in MetaTrader 5 if you need to. To connect it again you need a new enrollment token.

> [!TIP] Suspect a leak?
> Revoke, do not rotate. Rotating keeps the old secret working until the new one is first used.

## If something goes wrong

```decide
Does part 4 of the Guided connection page say Connected, with a green box?
Yes: Your terminal is connected. If it later turns to stale, MetaTrader 5 has closed or gone offline.
No, it still says Waiting for the terminal: MetaTrader 5 has not reached Lascodia. Check the allow-list (Step 3a), that the EA is on a chart, and that the Algo Trading button is green.
No, it shows a red message: Find the message in the questions below. Most refusals keep the token valid once you fix the cause.
Not sure: Open Organisation → Connect a terminal. A terminal whose State is Active, with a recent Last used time, is connected.
```

?? The page keeps saying "Waiting for the terminal to use the token…".
   Nothing has reached Lascodia yet. Check, in order:

   1. **The allow-list.** In MetaTrader 5, open **Tools → Options → Expert Advisors**. The address from the console must be listed exactly: `https://`, the host, and the port if it has one.
   2. **The EA is running.** It must be on a chart, with **Allow Algo Trading** ticked and the toolbar's **Algo Trading** button green.
   3. **The log.** In MetaTrader 5, open the **Toolbox** (**View → Toolbox**) and its **Experts** tab. Error **4060** or **4014** means the allow-list is wrong.

?? The EA's log shows error 4060 or 4014.
   MetaTrader 5 blocked the call because the engine address is not on the allow-list. Repeat [Step 3a](/docs/ea-install#3a-allow-the-ea-to-reach-lascodia), then remove the EA from the chart and attach it again.

?? It says "The engine turned the terminal away" and mentions demo accounts.
   Your organisation may connect **demo** accounts only, and MetaTrader 5 is signed in to a Real (or Contest) account. In MetaTrader 5, use **File → Login to Trade Account** to sign in to a demo account. The **same token still works**. To connect real-money accounts, talk to the platform team.

?? It says the enrollment token "has expired" or "was already used".
   A token works once, for 24 hours. Create a new token (Step 2). Then load the new preset in the EA's **Inputs** tab, or paste the token into `InpEnrollmentToken`.

?? It says "This enrollment token is for another trading account".
   You locked the token to one broker login, and MetaTrader 5 is signed in to a different one. Sign in to the right account, or create a new token without a broker login.

?? It says "This trading account belongs to another organisation".
   That broker account is already connected to a different organisation in Lascodia. It is never moved automatically. Contact the platform team. They have already been told.

?? It says "Your plan allows N connected terminal(s)".
   Your plan's terminal limit is reached. Revoke a terminal you no longer use, or ask about a larger plan. **Organisation → Plan & usage** shows your limits.

?? It is stuck on "Signed in; waiting for the EA to register…".
   Lascodia may not recognise the market names the EA sent. Many brokers add letters to names (for example `EURUSDm`). Set `InpBrokerSymbolSuffix` (here `m`), or `InpSymbolMapping`, in the EA's **Inputs** tab. Check the **Experts** log for errors.

?? It says "The EA is older than the engine expects".
   Download the current EA (Step 1), copy it over the old `LascodiaEA.ex5` in **MQL5 → Experts**, and attach the EA to the chart again.

?? Prices are refused as "future-dated", or a hint says "Check the computer's clock".
   The computer's clock is wrong by more than a few seconds. Turn on automatic time setting in Windows (**Settings → Time & language → Date & time**) or on your Mac.

?? It was Connected but now says "stale".
   The EA stopped checking in. MetaTrader 5 may be closed, or the computer asleep or offline. Start MetaTrader 5 and keep the computer awake and online. A terminal on an always-on server avoids this.

?? It says "This terminal's credential was revoked".
   Someone in your organisation switched this terminal off. If that was a mistake, create a new token and connect again.

?? The page says I may not download the EA.
   Downloading needs the **connect accounts** permission. Ask an Admin or Owner. The demonstration organisation cannot connect terminals at all.

## Where to next

```cards
rocket | Start here | The five steps from a new organisation to a live chart | /docs/getting-started
chart-candlestick | Using the chart | Prices, the order book, alerts and replay | /docs/user-guide
building | Running your organisation | People, safety switches, alerts and plans | /docs/admin-guide
cable | Connect a broker or exchange | Futures, crypto and stock brokers | /docs/connections-guide
```

# EA install guide

The Lascodia EA is the engine's only connection to brokers: it streams prices from MetaTrader 5 and places the orders
the engine sends it. Every EA instance holds **its own credential**, obtained once with a single-use enrollment token.

The fastest path is the console's wizard — **Organisation → Connect a terminal → Guided connection** — which does
steps 2–4 below with you and shows the engine's view of the terminal until its first heartbeat.

## Requirements

- MetaTrader 5 (Windows, or under Wine on macOS/Linux), signed in to the broker account to connect.
  Outside organisations may connect **demo** accounts only while the platform is demo-only.
- The EA file `LascodiaEA.ex5`, version **8.47.253 or later** (earlier builds cannot enroll with a token). Download it
  from the connection wizard (**Organisation → Terminals → Guided connection**) while signed in — it needs the permission
  to connect terminals and is never offered as a public link. The wizard shows the version, publication date and SHA-256
  of the file and checks the download against it. Copy it to `MQL5/Experts/` (File → Open Data Folder). The Terminals
  list marks a terminal **update available** when a newer build is published; install it the same way and attach the
  EA again.
- The engine's address, e.g. `https://app.example.com/api/v1/lascodia-trading-engine` (the wizard shows yours).

## 1. Allow the EA to reach the engine

MetaTrader 5 only lets an EA call listed addresses. **Tools → Options → Expert Advisors**, tick **Allow WebRequest for
listed URL** and add the engine's origin — scheme and host only, for example:

```
https://app.example.com
```

Without it every call fails with **error 4060** in the terminal's _Experts_ log and nothing reaches the engine (the
wizard keeps saying "waiting for the terminal").

## 2. Install the EA

**File → Open Data Folder**, then `MQL5 → Experts`, and copy `LascodiaEA.ex5` there. In the Navigator, right-click
**Expert Advisors → Refresh**.

## 3. Create an enrollment token

In the console: **Organisation → Connect a terminal** (needs the _connect accounts_ permission and a recent
second-factor sign-in). Name the terminal; optionally bind the token to one broker login + server so no other account
can use it. The token (`lsc_enr_…`) is shown **once**, works **once**, and expires after **24 hours**. The wizard also
offers a preset file (`.set`) holding the token and the engine address.

## 4. Attach and connect

Drag the EA onto any chart. In **Common**, tick **Allow Algo Trading**. In **Inputs**, press **Load** and choose the
preset, or set:

| Input                | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| `InpEngineBaseUrl`   | the engine address (with `/api/v1/lascodia-trading-engine`) |
| `InpEnrollmentToken` | the token from step 3                                       |

Press OK and make sure the toolbar's **Algo Trading** button is green. The EA exchanges the token for its credential
(kept in `MQL5/Files/Lascodia/`), signs in, registers its symbols and starts sending heartbeats every 30 seconds.
Delete the preset file afterwards — the token is spent.

Other useful inputs: `InpSymbols` (`CHART`, a comma-separated list, or `ALL`), `InpBrokerSymbolSuffix` /
`InpBrokerSymbolPrefix` / `InpSymbolMapping` when the broker names symbols differently (e.g. `EURUSDm`).

## Troubleshooting

| What you see                                                | Why                                                         | What to do                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| Wizard waits; _Experts_ log shows 4060                      | The engine address is not allow-listed                      | Step 1 — add the origin exactly (https, host, port if any) |
| "The enrollment token expired"                              | 24 hours passed, or it was already used                     | Create a new token                                         |
| "The engine turned the terminal away: … demo accounts only" | The terminal is signed in to a Real/Contest account         | Sign MT5 in to a demo account; the token stays valid       |
| "…belongs to another organisation"                          | That broker account is registered elsewhere                 | Ask platform staff; the account is never moved             |
| "Your plan allows N connected terminals"                    | The plan's terminal limit is reached                        | Disconnect one, or ask about a larger plan                 |
| Signed in but never registers                               | The chart symbol or symbol mapping is unknown to the engine | Check `InpSymbols` / suffix / mapping and the Experts log  |
| Registered, then **stale**                                  | MT5 closed, asleep or offline                               | Keep the terminal running and online                       |
| Prices rejected as "future-dated"                           | The computer's clock is wrong                               | Turn on automatic time synchronisation                     |
| "This EA is older than the engine expects"                  | EA below 8.47.253                                           | Install the current EA and attach it again                 |
| "Credential revoked"                                        | Someone revoked this terminal                               | Create a new token and connect again                       |

## Disconnecting a terminal

**Organisation → Connect a terminal → Machine credentials → Revoke**. The engine refuses it within 30 seconds; open
positions stay with the broker. **Rotate** gives a terminal a new secret at its next sign-in (hygiene); for a suspected
leak, revoke and enroll again.

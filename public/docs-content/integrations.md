# Data feeds and integrations

> [!SUMMARY]
> Outside programs connect to the Lascodia engine in two directions. **Feed programs** bring in market data that MetaTrader 5 cannot give: CME futures order books, FX venues over FIX, crypto exchanges and US stocks. Going the other way, the engine sends **alert webhooks** out, and your own scripts call in with **access tokens**.
> This guide explains how each one signs in, what you must have in place first, and how to check it works.

```stack
Feed programs | CME futures, FX venues, crypto, US stocks | satellite
-> post prices to the engine, each with its own machine identity
Lascodia engine | Stores the data and serves it to entitled organisations | server
-> sends signed alerts out to
Your webhook receiver | Any https address you run | webhook
@caption Scripts and tools call in the other way, with a personal access token.
```

## How machines sign in

Every program that talks to the engine on its own (an EA, a feed program) has its own **machine credential**. No password or shared key is ever typed into a machine.

```flow
Create an enrolment token | A one-time key, made by a person | key-round
Enrol once | The program trades it for its own credential file | download
Short-lived tokens | The credential buys a 15-minute token as needed | refresh-cw
@caption If the credential is lost, make a new enrolment token and enrol again.
```

- A person holding `accounts.connect` creates the enrolment token (`POST machine/enrollments`). The kind is `EaTerminal` for an EA, or `Daemon` for a feed program.
- The program enrols once and keeps its credential file. From then on it trades the credential for 15-minute tokens.
- For feed programs, the token must be created by staff acting in House, and the program's machine id (its **daemon id**) is what you name as a source's writer on **Data sources**.

## CME futures order books (Databento, Rithmic, Tradovate, CQG)

Live CME futures depth comes from the **CME feed program** (`lascodia-cme-feed`, written in Python). It runs as a separate process, so a stalled vendor connection can never slow the engine down. It sends exact per-level order-book changes, the best bid and ask, and trades tagged with which side started them (the **aggressor**). The engine stores them (CME books for 400 days) and builds minute bars, the futures–spot gap (**basis**) and the order-flow views from them.

Vendors it can read from: Databento (`mbp-10` data), Rithmic, Tradovate and CQG. Each has its own source on **Data sources**: `cme-databento`, `cme-rithmic`, `cme-tradovate`, `cme-cqg`. All are disabled today.

- [ ] A vendor subscription, and the CME market-data agreement (display and non-display use, with monthly usage reporting)
- [ ] A Daemon enrolment token, made by staff acting in House
- [ ] For CQG only: CQG's WebAPI protocol files, from CQG's partner site, built into the program's image

1. **Licence.** Sign the vendor subscription and the CME agreement.
2. **Identity.** Create a Daemon enrolment token. Start the program once with it; it enrols and keeps its credential file. Then remove the token from its settings.
3. **Source.** On **Data sources**, set the writer of the vendor's source (for example `cme-databento`) to the program's daemon id (`cme-databento-feed` by default) and enable it ((1)). Until then nothing is stored.
4. **Run.** Choose the futures roots with the program's `FUTURES_ROOTS` setting and start it.
5. **Entitle.** Grant `cme-l2` and `cme-trades` to the organisations licensed to see them, on **Data entitlements**. House sees every feed.

![Data sources: ((1)) the CME vendor sources, disabled until a licence and a writer are in place](int-sources "/market-data/sources")

> [!TIP] Test without a vendor account
> The program's `replay` mode streams a recorded Databento file through the same code into a local sink. It is the way to test before any vendor is paid for.

> [!NOTE]
> ICE and Eurex futures are also available through Databento, as the sources `ice-databento` and `eurex-databento` (each a separate Databento licence).

## FX venues over FIX (LMAX, cTrader, Currenex, Integral and others)

**FIX** is the standard message language banks and trading venues use. The **venue feed program** (`LascodiaVenueFeed`, .NET, FIX 4.4) connects to a venue's market-data session and posts its prices to the engine as the source `venue-<id>`. It only runs when started on purpose (the `venues` compose profile). Full steps: engine runbook *venue-onboarding.md*.

```flow
Agreement | The venue's market-data contract and onboarding pack | handshake
Network | Allow-list our fixed address, or a VPN | network
Register | Data sources → Register a venue (created disabled) | radio-tower
Certify on UAT | The venue's test system first | flask-conical
Go live | Production, then grant the feed | circle-check-big
```

1. **Agreement.** Get the venue's market-data agreement and its onboarding pack: rules of engagement, data dictionary, addresses, CompIDs (the names each side uses in FIX), credentials and instrument list.
2. **Network.** Have the venue allow-list the host's fixed outgoing address (or set up a cross-connect or VPN). Use TLS as the venue requires.
3. **Check the profile.** Every value marked *unverified* in the venue's profile must be checked against the pack.
4. **Identity.** Create a Daemon enrolment token for the program (first start only).
5. **Source.** On **Data sources**, click {{Register a venue}} for a new venue ((1)): enter the **Venue id (lowercase, e.g. lmax)**, **Display name**, contract size and the symbol map, then {{Register (disabled)}}. Set the writer to the program's daemon id, and enable it when ready.
6. **Settings.** Fill in the program's venue settings (host, port, CompIDs, credentials, symbols) and start only the venue feed program.
7. **Certify.** On the venue's test system (UAT): logon, subscribe, snapshot, incremental updates, gap and resend, logout. Then do the same in production.
8. **Entitle.** Grant `venue:<id>` to the organisations that may see it.

![Registering a venue: ((1)) the new venue's id, name, size and symbol map](int-register-venue "/market-data/sources")

> [!SUCCESS]
> The source shows data arriving, and an entitled organisation sees the venue's prices on the chart.

## Crypto exchanges and US stocks

Two more feed programs follow the same pattern: enrol, set the writer, enable the source, start the program, grant the feed.

| Program | Brings in | Sources and feeds | Runbook |
| --- | --- | --- | --- |
| Crypto feed (`crypto` compose profile) | Trades, order books, funding, open interest and liquidations from Binance, Coinbase, Kraken, Bybit and OKX public streams. No exchange key needed. | `crypto-binance` … `crypto-okx`; feed `crypto:<exchange>` | *crypto-feed-onboarding.md* |
| US stocks feed (`equities` compose profile) | Best bid and offer, trades, halts. Needs a Polygon and/or Databento subscription and key. | `equities-polygon`, `equities-databento`, `equities-databento-xnas`; feeds `us-equities-nbbo`, `us-equities-depth:xnas` | *equity-feed-onboarding.md* |

> [!WARNING]
> Crypto exchange addresses do not resolve through the office router. The engine's containers use public DNS servers for this; see [Network: crypto exchanges and DNS](/docs/multi-asset-setup#network-crypto-exchanges-and-dns).

## Alert webhooks

A **webhook** is an address on the internet that Lascodia calls when something happens, so your own systems can react (open a ticket, page someone). An organisation sets it up on **Organisation → Alert channels**.

1. Open **Organisation → Alert channels** and find the **Webhook** channel.
2. Enter the **URL** ((1)). It must be https and a public host. Lascodia never follows redirects, and never calls private or internal addresses.
3. Leave **Signing secret** empty to have one made for you ((2)), or enter your own (32 to 256 characters). It is shown once: copy it into your receiver straight away.
4. Click {{Set up}} (or {{Save}}), then {{Send a test}} to check your receiver.

![Alert channels: ((1)) the webhook address, ((2)) the signing secret](int-webhook "/organisation/alerts")

### Check every delivery's signature

Each delivery is a JSON `POST` with two extra headers. The signature proves the message came from Lascodia and was not changed or replayed.

```bash
X-Lascodia-Timestamp: <unix seconds>
X-Lascodia-Signature: v1=<lower-case hex HMAC-SHA256(secret, timestamp + "." + raw body)>
```

1. Read the **raw** body bytes before parsing the JSON. Parsing and re-encoding changes the bytes and breaks the check.
2. Refuse the delivery if the timestamp is more than **5 minutes** away from your clock.
3. Work out HMAC-SHA256 with your secret over: the timestamp, a full stop, then the raw body.
4. Compare it, in constant time, with **every** `v1=` value in the signature header. While a secret is being rotated, several values may appear; any one match is enough.

```python
import hmac, hashlib, time

def verify(secret: str, timestamp: str, signature_header: str, raw_body: bytes, tolerance=300) -> bool:
    if not timestamp or not signature_header or not timestamp.isdigit():
        return False
    if abs(time.time() - int(timestamp)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, part.strip()[3:])
               for part in signature_header.split(",") if part.strip().startswith("v1="))
```

```javascript
const crypto = require("crypto");
function verify(secret, timestamp, signatureHeader, rawBody /* Buffer */, toleranceSec = 300) {
  if (!/^\d+$/.test(timestamp || "") || !signatureHeader) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(timestamp + "."), rawBody])).digest();
  return signatureHeader.split(",").map(s => s.trim()).filter(s => s.startsWith("v1="))
    .some(s => { const got = Buffer.from(s.slice(3), "hex");
                 return got.length === expected.length && crypto.timingSafeEqual(got, expected); });
}
```

The same samples are on the **Alert channels** page under *Receiving the webhook: check every delivery's signature*.

![The receiver help on Alert channels: the two headers, with Python and Node.js samples](int-webhook-help "/organisation/alerts")

> [!WARNING] Rotating the secret
> {{Rotate signing secret…}} makes a new secret and shows it once. The old one stops signing **at once**, so deliveries fail your check until your receiver has the new one. Have it ready to paste.

> [!NOTE]
> An older receiver may compare the secret itself, sent in the `X-Lascodia-Secret` header. That option still exists for such receivers, but it is deprecated: the secret travels in clear. Move to signatures and turn it off.

## Access tokens for scripts and tools

A **personal access token** lets a script call the engine as you: for example a nightly export of your profit and loss. It only works in the organisation you made it in, and only with the permissions you choose, which can never be more than you hold yourself.

Open **Administration → Access tokens** (`/account/tokens`). This page works only when the platform has turned tokens on (`Auth:PersonalAccessTokens:Enabled`).

1. Enter a **Name — what will use it** ((1)), such as "Nightly P&L export".
2. Choose **Expires after** ((2)): 7, 30, 90, 180 or 365 days.
3. Tick only the **Permissions** the script needs ((3)).
4. Click {{Create token}} at the bottom of the list. Creating a token asks for your second factor.
5. Copy the token (it starts `lsc_pat_`). It is shown **once**.

![Access tokens: ((1)) name, ((2)) lifetime, ((3)) permissions](int-tokens "/account/tokens")

Send it on every call:

```bash
curl -s "https://<your-engine-host>/api/v1/lascodia-trading-engine/<endpoint>" \
  -H "Authorization: Bearer lsc_pat_..."
```

> [!DANGER] Treat a token like a password
> Anyone who has it can act as you, within its permissions, until it expires. Never put it in code you share or commit. If it leaks, click {{Revoke}} on its row at once.

> [!TIP]
> A token's permissions are checked against yours on every call. If you lose a permission, the token loses it too. A token cannot create other tokens.

Organisations that manage people in their own identity provider can also provision them over **SCIM 2.0** (`/scim/v2`), with a SCIM token. The [API overview](/docs/api-overview) and the [API reference](/docs/api) list every endpoint.

## If something goes wrong

```decide
Does your receiver reject every webhook delivery?
Yes: Check you sign the raw body bytes (not re-encoded JSON), the secret matches the latest one, and your server clock is right to within 5 minutes.
No: If only some fail, they may be old deliveries retried after more than 5 minutes; that is the replay check working.
Not sure: Click Send a test on Alert channels and log the two headers and the raw body you receive.
```

?? A feed program runs but nothing is stored.
   On **Data sources**, check the source is enabled and its writer is exactly the program's daemon id. A source with no writer, or disabled, stores nothing.

?? The program cannot enrol.
   Enrolment tokens are one-time. Create a new Daemon token (staff acting in House) and start the program with it again.

?? An organisation cannot see the new feed.
   Grant the feed on **Data entitlements**, and check the organisation's plan includes it.

?? My script gets "-401" or "-403".
   `-401` means the token is wrong, expired or revoked. `-403` names the permission the token lacks: make a new token with it. See the codes in the [API overview](/docs/api-overview#the-response-envelope).

## Where to next

```cards
braces | API overview | Address, sign-in, response format, limits | /docs/api-overview
server | Platform operator guide | Data sources, entitlements and usage | /docs/platform-guide
layers | Switching on futures, crypto and stocks | Margins, fees and a safe rollout | /docs/multi-asset-setup
building | Running your organisation | Alert channels and people | /docs/admin-guide
```

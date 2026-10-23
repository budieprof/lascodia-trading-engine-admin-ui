# Integration guides

How external systems connect to the engine. Every machine connection uses its own **machine credential**, obtained
once with an enrollment token (`POST machine/enrollments` by a person holding `accounts.connect`, kind `EaTerminal` or
`Daemon`) and traded for 15-minute tokens. No password or shared key is ever configured on a machine.

## CME futures depth (Databento / Rithmic)

Live CME FX futures (6E, 6B, 6J, 6A, 6C, 6S, 6N) come from the **CME feed sidecar** (`lascodia-cme-feed`, Python;
Databento `mbp-10` or Rithmic), a separate process so a stalled vendor connection can never affect the engine.

1. **Licence**: the vendor subscription and the CME market-data agreement (display / non-display, usage reporting).
2. **Machine identity**: staff acting in House create a _Daemon_ enrollment token; the sidecar enrolls once and keeps
   its credential file.
3. **Registry**: in **Data sources** set the writer of `cme-databento` (or `cme-rithmic`) to the sidecar's daemon id
   (`cme-databento-feed` by default) and enable it. Until then nothing is stored.
4. **Run** the sidecar against the vendor. It posts exact per-level book events, best bid/ask and aggressor-tagged
   trades of the front month to `md/ingest`; the engine keeps them in the market-data store (CME books 400 days) and
   derives minute bars, the futures-spot basis and the order-flow analytics.
5. **Entitlements**: grant `cme-l2` / `cme-trades` to the organisations licensed to see them (House sees every feed).

The sidecar's `replay` mode streams a recorded Databento slice through the same code to a local sink — the way to test
without a vendor account.

## FX venues over FIX (LMAX, cTrader, Currenex, Integral, generic)

The **venue feed sidecar** (`LascodiaVenueFeed`, .NET, QuickFIX/n FIX 4.4 market-data client) connects to a venue's
market-data session and posts to `md/ingest` as `venue-<id>`. It runs only when started explicitly (compose profile
`venues`). Engine runbook: _venue-onboarding.md_. In short:

1. Commercial and legal: the venue's market-data agreement and its onboarding pack (rules of engagement, data
   dictionary, endpoints, CompIDs, credentials, instrument list).
2. Network: whitelist the host's fixed egress IP (or cross-connect / VPN); TLS per the venue.
3. Verify every value marked _unverified_ in the venue's profile against the pack.
4. A Daemon enrollment token for the sidecar (first start only).
5. **Data sources**: set the venue's writer to the sidecar's daemon id and enable it (a new venue: **Register a venue**).
6. Fill the sidecar's venue settings (host, port, CompIDs, credentials, symbols) and start only the sidecar.
7. Certify on the venue's UAT (logon, subscribe, snapshot, incremental, gap / resend, logout), then production.
8. Grant `venue:<id>` to the organisations that may see it.

## Alert webhooks

An organisation's webhook channel (**Organisation → Alert channels**) receives JSON alerts signed with
`X-Lascodia-Timestamp` and `X-Lascodia-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>`. Verify the
signature and reject timestamps older than 5 minutes. Organisation webhooks may only reach public addresses and are not
redirected.

## API access for scripts and tools

- **Personal access tokens** (`lsc_pat_…`, **My account → Access tokens**, when the platform enables them): act as you,
  bounded by the permissions you choose, for at most 365 days. Send `Authorization: Bearer lsc_pat_…`.
- **SCIM 2.0** (`/scim/v2`) for provisioning people from your identity provider, with a SCIM token.
- The [API overview](/docs/api-overview) and the [API reference](/docs/api) list every endpoint.

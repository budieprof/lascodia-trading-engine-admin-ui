# Platform operator guide

For platform staff (super admins, and House administrators holding the `platform.*` keys while acting in House). The
**Platform** group of the sidebar holds these pages; every action is audited.

## Organisations

**Organisations** (`/platform/organisations`): create a Customer or Canary organisation (its plan, whether it may feed
platform learning — only with its written agreement), suspend or reactivate it, see its members, its plan and usage.

**Seat its first Owner**: a new organisation has nobody in it, so its own invitations cannot start. Use **Invite first
Owner** on its row: the person receives the Owner role organisation-wide when they accept (e-mailed set-up link, or a
link + one-time password you pass on when the identity provider cannot send e-mail). It is refused for House, the
demonstration organisation, an inactive organisation, and one that already has an active Owner — from then on its
Owner invites everyone else.

Before the first outside organisation, work through the engine runbook _onboarding-outside-organisation.md_.

## Self-serve sign-up

Off by default. Engine settings (environment): `Tenancy:SelfServeSignup=true` turns it on, but it stays unavailable
unless outside organisations are demo-only, the identity provider's admin client and console sign-in (BFF) are on, and
the realm can send e-mail. **Approval policy**: `Tenancy:SelfServeSignupRequiresApproval` — `true` (default) means staff
approve each new organisation in **Sign-ups** (`/platform/signups`); `false` creates it automatically at the person's
first verified sign-in. Limits: `…MaxPerIpPerDay` (3), `…MaxPerDomainPerDay` (10), throwaway-mail domains refused.

## Plans and fleet

- **Plans** (`/platform/plans`): limits per plan; one plan is the default for new organisations (Trial). House is never
  limited. Lowering a plan removes nothing — it only refuses new creations.
- **Fleet health** (`/platform/fleet`): every organisation's terminals, their heartbeat age, EA version and state, and
  engaged kill switches.

## Market-data sources

**Data sources** (`/market-data/sources`): every source the engine stores.

| Kind                                         | Who writes it                                                                                  | What staff do                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| MT5 broker                                   | Trusted EAs (House by default) — the engine creates the row when a broker server first streams | Nothing here; trust is `MarketData:SourceTrust:*`                    |
| CME futures (`cme-databento`, `cme-rithmic`) | The CME feed sidecar's machine id                                                              | Enable, set the writer id, after the vendor licence is in place      |
| FX venue (`venue-<id>`)                      | The venue sidecar's machine id                                                                 | Register (created disabled), verify the profile, set writers, enable |

Enabling a source starts storing its data and shows it to every organisation entitled to its feed — check the licence
first. **Data entitlements** (`/market-data/entitlements`) decides who may read which feed (display / non-display);
**Data usage** (`/market-data/usage`) is the monthly report for exchange declarations.

## The public demonstration

`/demo` shows the console's chart and order book on **recorded** data replayed on a loop — labelled as recorded on every
screen, with no order entry. The engine serves it from the market-data store; only feeds every organisation may read
without a licence (`MarketData:Entitlements:DefaultFeeds`, the broker feeds) are ever shown. Turn it on with engine
settings (**Config** page, `/engine-config`, platform layer):

| Key                          | Default  | Meaning                                                                                          |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `Demo:Enabled`               | `false`  | Serve `demo/*` and create the showcase organisation `demo` at the next engine start              |
| `Demo:Replay:WindowStartUtc` | (blank)  | Start of the recorded window, e.g. `2026-10-21T08:00:00Z` — must be inside the store's retention |
| `Demo:Replay:WindowMinutes`  | `120`    | Window length (10–240); the replay loops over it                                                 |
| `Demo:Replay:Symbols`        | `EURUSD` | Up to 6 symbols                                                                                  |
| `Demo:Replay:SourceId`       | (blank)  | The recorded source; blank = a broker source that holds the window                               |

Pick a busy weekday window (book snapshots are kept 90 days, ticks 400). The **showcase organisation** (`demo`, kind
Demo) never trades: every account of it is refused on every enrollment, sign-in and order path. Add people to it with a
Viewer grant to give them a read-only tour; the console shows a "Demonstration organisation" banner while they act in it.

## Terminal wizard settings

| Key                             | Meaning                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `Onboarding:EngineBaseUrl`      | The engine address EAs are told to use (blank = the console's own origin + the API path) |
| `Onboarding:EaDownloadUrl`      | Optional https override for the EA file (blank = the engine's own signed-in download)    |
| `Onboarding:EaMinimumVersion`   | Oldest EA that enrolls with a token (`8.47.253`); never raised by publishing             |
| `Onboarding:EaReleaseRetention` | Published EA builds the engine keeps (`5`)                                               |

The EA file is published to the engine by every EA rollout (`make rollout`, step 3b, after the binary is verified on
every host's disk) and downloaded by signed-in members from the connection wizard — never from a public link. Staff can
list the published builds with `GET platform/ea/releases` (`platform.ea.releases.manage`).

## Closing organisations

**Closed organisations** (`/platform/closures`): reopen within the grace period, record the dry-run deletion plan, then
confirm deletion with the organisation's handle (`platform.tenants.purge`, step-up).

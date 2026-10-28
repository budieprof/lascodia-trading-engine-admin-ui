# Platform operator guide

> [!SUMMARY]
> This guide is for platform staff: the people who run Lascodia itself, for every customer organisation. It covers creating and approving organisations, plans and billing, watching the whole fleet of terminals, who may see which market data, and closing organisations.
> The pages are in the **Platform** group of the sidebar. Every action on them is recorded in an audit log, usually the affected organisation's own.

```flow
Create or approve | A new organisation, by hand or from a sign-up | building
Seat its first Owner | One invitation; they invite everyone else | user-plus
Plan and data | What it may use and which feeds it may read | package
Watch and bill | Fleet health, usage and invoices | heart-pulse
Close | Reopen in the grace period, or delete for good | door-open
@caption The life of a customer organisation, as platform staff see it.
```

## Who can use these pages

You see the **Platform** group when you are a super admin, or a House administrator holding `platform.*` permissions while acting in House. **House** is the platform's own organisation: it runs the platform's accounts and is never limited by a plan.

| Page | Sidebar | Address |
| --- | --- | --- |
| Organisations | **Platform → Organisations** | `/platform/organisations` |
| Plans | **Platform → Plans** | `/platform/plans` |
| Fleet health | **Platform → Fleet health** | `/platform/fleet` |
| Billing | **Platform → Billing** | `/platform/billing` |
| Data entitlements, usage, sources, declarations | **Platform → Data …** | `/market-data/…` |
| Sign-ups | **Platform → Sign-ups** | `/platform/signups` |
| Closed organisations | **Platform → Closed organisations** | `/platform/closures` |
| Elevated access | **Platform → Elevated access** | `/platform/elevations` |
| Impersonation | **Platform → Impersonation** | `/platform/impersonation` |
| Security evidence | **Platform → Security evidence** | `/platform/security-evidence` |

> [!NOTE]
> Before the first outside organisation goes live, work through the engine runbook *onboarding-outside-organisation.md*.

## Organisations

**Organisations** lists every organisation on the platform, with its kind, status, plan, number of members and when it was created.

![Organisations: ((1)) add an organisation, ((2)) its people, ((3)) its plan and usage](plat-orgs "/platform/organisations")

The month list and {{Usage export (CSV)}} at the top download every organisation's usage for one month.

### Create an organisation

1. Click {{New organisation}} ((1)).
2. Enter the **Slug (permanent)**: the short name used in addresses, such as `acme-capital`. It cannot be changed later.
3. Enter the **Name**.
4. Choose the **Kind**: **Customer** for a real customer, or **Canary (isolation probe, demo accounts only)** for a test organisation that checks one organisation cannot see another's data.
5. Choose a **Plan**, or leave **The default plan**.
6. Tick **Its trading may feed platform-wide research and models** only if the organisation has agreed to it in writing.
7. Click {{Create}}.

![The new-organisation form](plat-new-org "/platform/organisations")

### Seat its first Owner

A new organisation has nobody in it, so it cannot invite anyone itself. You add the first **Owner**; from then on the Owner invites everyone else.

1. Click {{Invite first Owner}} on the organisation's row.
2. Enter the **Owner's e-mail address** and click {{Invite}}.
3. The person receives the Owner role for the whole organisation when they accept. Normally they get an e-mail with a set-up link. If the sign-in service cannot send e-mail, the page shows an **invitation link** and a **one-time password** instead: pass both to the person yourself, by a safe route.

> [!NOTE]
> This is refused for House, the demonstration organisation, an inactive organisation, and an organisation that already has an active Owner.

### Suspend and reactivate

{{Suspend}} stops an organisation's people from using it until you {{Reactivate}} it. {{Members}} ((2)) lists its people, and {{Plan & usage}} ((3)) shows its plan and how much of each limit it uses.

## Self-serve sign-ups

People can also ask for an organisation themselves, from the sign-in page. This is **off** by default. It is controlled by engine settings in the environment (not the Config page):

| Setting | Default | What it does |
| --- | --- | --- |
| `Tenancy:SelfServeSignup` | `false` | `true` turns sign-up on |
| `Tenancy:SelfServeSignupRequiresApproval` | `true` | `true`: staff approve each request on **Sign-ups**. `false`: the organisation is created at the person's first verified sign-in |
| `…MaxPerIpPerDay` | 3 | Requests allowed per internet address per day |
| `…MaxPerDomainPerDay` | 10 | Requests allowed per e-mail domain per day |

Even when switched on, sign-up stays unavailable unless all of these are true: outside organisations are limited to demo accounts, the identity provider's admin client and console sign-in are on, and the sign-in service can send e-mail. Throwaway e-mail domains are refused.

![Sign-ups: ((1)) whether sign-up is on and can run (here it is off), ((2)) the requests](plat-signups "/platform/signups")

To decide a request, click {{Approve…}} or {{Turn down…}} on it, then confirm.

- **Approve** creates the organisation once the person has verified their e-mail address: on the Trial plan, demo accounts only, with the person as Owner.
- **Turn down** removes the person's sign-in.

## Plans

A **plan** sets what an organisation may use: how many accounts, connected terminals, people, research jobs, strategies and scripts, an LLM budget per month, and which features and market-data feeds. Empty limits are unlimited.

![Plans: ((1)) add a plan, ((2)) the default plan for new organisations](plat-plans "/platform/plans")

- {{New plan}} ((1)) adds one; {{Edit}} changes one.
- Exactly one plan is the **default** ((2)) that new organisations get (today, **Trial**). To change it, make another plan the default.
- **Market-data feeds** on a plan limit which feeds its organisations can be granted (empty means every feed).
- House is never limited by a plan.

> [!TIP]
> Lowering a limit removes nothing already in use. It only refuses new things above the limit.

## Fleet health

**Fleet health** shows every organisation's MetaTrader 5 terminals in one place: whether each is healthy, the EA's own state, its version, its last heartbeat (the "I am alive" message it sends every second), how it signs in, and any kill switches that are engaged.

![Fleet health: ((1)) how far back to look, ((2)) each organisation's terminals and kill switches at a glance](plat-fleet "/platform/fleet")

- Pick one organisation, or {{All organisations}}.
- Choose how far back to list disconnected terminals ((1)): the last 24 hours, 7 days or 30 days.
- **Stale** means connected, but no heartbeat for over 60 seconds.
- The page is read-only, and each view is recorded in the audit log. To act on a House terminal, use **System → EA Instances** or **System → Fleet Health**.

## Billing

**Billing** turns each organisation's metered usage into monthly invoices, using **price books**: versioned price lists per plan.

![Billing: ((1)) the Invoices, Price books and Usage tabs, ((2)) draft the month's invoices](plat-billing "/platform/billing")

On the **Invoices** tab ((1)), pick the month and click {{Draft invoices for …}} ((2)) once the month is over. Then work through each invoice:

```flow
Draft | Draft invoices for a month | file-text
Review | Check lines and add a note | clipboard-check
Finalise | Locks the invoice | lock
Collect | Record the payment | credit-card
@caption An invoice that is wrong after it is finalised is voided (a reason is required), not edited.
```

- **Price books**: {{New price book}} for a plan, {{New version}} to change prices from a given day, then {{Publish}}.
- **Usage**: pick an organisation and a month and click {{Show}} to see what it used.

> [!WARNING]
> No tax is calculated, and no real payment provider is connected. **Collect** records a payment; it does not take money.

## Market data: sources, entitlements and usage

Market data reaches Lascodia from **sources** (a broker server, a CME data vendor, an FX venue, a crypto exchange). Each source belongs to a **feed**, and an organisation may only read the feeds it is **entitled** to.

```stack
Data sources | Who may write each source, and whether it is on | radio-tower
-> each source belongs to a feed
Entitlements | Which organisation may read which feed | key-round
-> every read is counted in
Usage report | Monthly numbers for exchange declarations | chart-bar
@caption Turning a source on shows its data to every organisation entitled to its feed: check the licence first.
```

### Data sources

**Data sources** (`/market-data/sources`) lists every source the engine stores.

![Data sources: ((1)) register a new FX venue, ((2)) a CME vendor source, disabled until its licence is in place](plat-sources "/market-data/sources")

| Kind | Who writes it | What staff do |
| --- | --- | --- |
| MT5 broker | Trusted EAs (House by default). The engine creates the row the first time a broker server streams. | Nothing here. Which EAs are trusted is the setting `MarketData:SourceTrust:*`. |
| CME futures (`cme-databento`, `cme-rithmic`, `cme-cqg`, `cme-tradovate`) | The CME feed program's machine id | Set the writer id and enable it, once the vendor licence is in place |
| FX venue (`venue-<id>`) | The venue feed program's machine id | {{Register a venue}} (it is created disabled), check its settings, set the writers, enable it |
| Crypto exchange (`crypto-<exchange>`), US stocks (`equities-…`) | That data program's machine id | The same: set the writer, then enable |

All non-broker sources are disabled today. The [Data feeds and integrations](/docs/integrations) guide explains each feed program.

> [!DANGER] Check the licence before enabling
> Enabling a source starts storing its data and shows it to every organisation entitled to its feed.

### Entitlements

**Data entitlements** (`/market-data/entitlements`) decides which organisation may read which feed, for people looking at it (**display**) and for programs using it (**non-display**).

![Data entitlements: ((1)) the feeds everyone reads without a grant, ((2)) grant a feed](plat-entitlements "/market-data/entitlements")

- Every organisation reads the default feeds ((1)), today `broker-ticks` and `broker-dom`, without a grant, within its plan. House reads every feed.
- To give access: {{Grant a feed}} ((2)), choose the **Organisation** and **Feed**, tick **Display** and/or **Non-display**, set **Starts** and **Ends** (empty = until revoked), give a **Reason** (contract, order form, trial), then {{Grant}}.
- {{Revoke}} ends the organisation's live chart subscriptions to that feed within seconds, and refuses its history reads from the next request.

![The grant form: organisation, feed, start and end, and the reason](plat-grant "/market-data/entitlements")

### Usage and declarations

**Data usage** (`/market-data/usage`) is the monthly report exchanges and data vendors ask for: per feed and month, how many people looked at it and which programs used it, across how many organisations. Download it with {{CSV per exchange}}, {{CSV per organisation}} or {{CSV per user}}.

![Data usage: ((1)) the month, ((2)) the CSV downloads](plat-usage "/market-data/usage")

> [!TIP]
> File a declaration only after the month has ended. The current month is marked as still running, and its counts can still grow.

Exchanges also need each person who sees real-time data to declare whether they are a **professional** or **non-professional** user. People sign these on **Trading → Data declarations**. Staff review them on **Platform → Data declarations** (`/market-data/declarations-review`):

1. Click {{Review}} on a declaration.
2. Choose the **Decision**: accept, reject, or reclassify. Rejecting ends the person's real-time access to that exchange.
3. Write a note (needed for everything except accepting; the person sees it), then click {{Save review}}.

![Declarations review: every organisation's people and their declarations per exchange](plat-declarations "/market-data/declarations-review")

## Closed organisations

When an Owner closes their organisation, it appears on **Closed organisations** with a **grace period**: time in which it can still be brought back.

![Closed organisations: each closure, its grace period and the deletion steps](plat-closures "/platform/closures")

1. To bring it back, click {{Reopen…}} while the grace period lasts.
2. To delete its data for good, first click {{Make a deletion plan (dry run)}}. The plan lists every table and how many rows would go, who is removed, what is kept, and anything blocking the deletion.
3. When the grace period is over and the plan shows no blockers, click {{Delete its data…}} and type the organisation's handle to confirm.

> [!DANGER] Deletion cannot be undone
> Deleting needs the `platform.tenants.purge` permission and a fresh second-factor check. House can never be closed.

## Elevated access

Staff do not see an organisation's data by default. **Elevated access** gives you time-limited access to one organisation, approved by a second staff member.

1. Choose the **Organisation** ((1)).
2. Tick the **Permissions needed** ((2)).
3. Set **For how long** ((3)), at most 240 minutes.
4. Explain **Why** ((4)). This goes into the organisation's audit log.
5. Click {{Request access}}. Another staff member must click {{Approve}} before it starts.
6. Click {{End}} when you are done, rather than waiting for it to run out.

![Elevated access: ((1)) organisation, ((2)) permissions, ((3)) how long, ((4)) why. The Request access button is below the permission list](plat-elevations "/platform/elevations")

## Impersonation

**Impersonation** shows you the console exactly as another person sees it, to help them with a problem. It is **read-only**: every change is refused.

1. Choose the organisation ((1)), then the person.
2. Write **Why** (it is recorded in their organisation's audit log).
3. Click {{View as}}. A banner stays on every page until you end it.

![Impersonation: ((1)) choose the organisation to list its people](plat-impersonation "/platform/impersonation")

## Security evidence

When an auditor asks for evidence of how the platform is run, **Security evidence** builds one signed archive for a period. It holds the access reviews and sign-offs, audit-log integrity checks, backup and restore drill reports, release notes and vulnerability-scan summaries, with a list of fingerprints for every file.

1. Set **From** and **To** ((1)).
2. Click {{Download evidence bundle}} ((2)). Each download is recorded in the audit log.

![Security evidence: ((1)) the period, ((2)) download the archive](plat-evidence "/platform/security-evidence")

> [!NOTE]
> The archive is evidence for your own assessment and your auditor. It is not a certificate of compliance with SOC 2, ISO 27001 or any other standard.

## The public demo

The **demo** (`/demo`, linked from the sign-in page) lets anyone try the chart and order book without an account. It plays back **recorded** prices on a loop, is labelled as recorded on every screen, and has no order entry. Only feeds every organisation may read without a licence (the broker feeds, `MarketData:Entitlements:DefaultFeeds`) are ever shown.

![The demo page while it is switched off: the recorded-data banner, and "The demo is not available on this server"](plat-demo "/demo")

Turn it on with these settings on the **Config** page (`/engine-config`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `Demo:Enabled` | `false` | Serve the demo, and create the showcase organisation `demo` at the next engine start |
| `Demo:Replay:WindowStartUtc` | (blank) | Start of the recorded window, for example `2026-10-21T08:00:00Z`. It must still be inside the stored history |
| `Demo:Replay:WindowMinutes` | `120` | Window length, 10 to 240 minutes; the replay loops over it |
| `Demo:Replay:Symbols` | `EURUSD` | Up to 6 symbols |
| `Demo:Replay:SourceId` | (blank) | The recorded source. Blank means a broker source that holds the window |

> [!TIP]
> Pick a busy weekday window. Order-book snapshots are kept for 90 days and ticks for 400.

The **showcase organisation** (`demo`) never trades: every account in it is refused on every enrolment, sign-in and order path. To give someone a read-only tour, add them to it with a Viewer grant. The console shows a "Demonstration organisation" banner while they act in it.

## Terminal set-up settings

These settings shape the **Connect a terminal** wizard that organisations use to link MetaTrader 5.

```stack
EA rollout | Verifies the EA file on every host, then publishes it to the engine | upload
-> kept by the engine (last 5 builds)
Engine download | Only for signed-in members, never a public link | lock-keyhole
-> offered by
Connect a terminal wizard | Download, one-time token, address to allow | plug
```

| Setting | Meaning |
| --- | --- |
| `Onboarding:EngineBaseUrl` | The engine address EAs are told to use. Blank means the console's own address plus the API path |
| `Onboarding:EaDownloadUrl` | Optional https address for the EA file. Blank means the engine's own signed-in download |
| `Onboarding:EaMinimumVersion` | The oldest EA that may enrol with a token (`8.47.253`). Publishing a new EA never raises it |
| `Onboarding:EaReleaseRetention` | How many published EA builds the engine keeps (`5`) |

The EA file is published to the engine by every EA rollout (`make rollout`, step 3b, after the file is verified on every host). Staff can list the published builds with `GET platform/ea/releases` (permission `platform.ea.releases.manage`).

## If something goes wrong

```decide
Is the self-serve sign-up option missing from the sign-in page?
Yes: Open Sign-ups. It says whether sign-up is on and, if it cannot run, why (for example the sign-in service cannot send e-mail).
No: Requests appear on Sign-ups while approval is required. Approve or turn them down there.
```

?? "Invite first Owner" is refused.
   It only works for an active organisation with no active Owner, and never for House or the demonstration organisation. If the organisation already has an Owner, that Owner invites people from **Organisation → Invitations**.

?? The invitation e-mail never arrives.
   The sign-in service may not be able to send e-mail. Use the invitation link and one-time password the page shows, and pass them on yourself by a safe route.

?? An organisation cannot see a feed it has been granted.
   Check its plan: the plan's **Market-data feeds** limit what can be served, and the entitlements page marks a grant the plan does not include. Also check the source is enabled on **Data sources**.

?? I cannot see an organisation's data to help them.
   Ask for **Elevated access** and have another staff member approve it, or use **Impersonation** to see what they see.

?? The deletion button stays disabled.
   The grace period has not ended, or the deletion plan lists a blocker. Make a new dry-run plan to see what is in the way.

## Where to next

```cards
layers | Switching on futures, crypto and stocks | Margins, fees and the safe rollout | /docs/multi-asset-setup
satellite | Data feeds and integrations | CME depth, FIX venues, webhooks, tokens | /docs/integrations
building | Running your organisation | What an organisation's admins see | /docs/admin-guide
braces | API overview | Signing in from code and the response format | /docs/api-overview
```

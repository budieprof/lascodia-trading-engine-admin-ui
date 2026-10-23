# Getting started

This guide takes a new organisation from nothing to its first live chart. Each step names the console page where it
is done; the **Get started** page (`/onboarding`) shows the same list with a tick for every step already done.

> Outside organisations are **demo-only** while the platform runs that policy: only MetaTrader 5 *demo* accounts can be
> connected and traded. A Real or Contest account is refused at every step (enrollment, sign-in, orders).

## 1. Get an organisation

There are two ways in.

- **Self-serve sign-up** — on the sign-in page choose **Create an organisation** (shown only while the platform offers
  it). Enter your e-mail, your name and the organisation's name. You receive an e-mail to verify your address and set a
  password and an authenticator app. Depending on the platform's policy the organisation is created at your first
  verified sign-in, or after platform staff approve it. You become its **Owner**.
- **Created by platform staff** — staff create the organisation and send its first Owner an invitation
  (Platform → Organisations → **Invite first Owner**). Accept it from the e-mail, or from the link staff pass on.

## 2. Invite the people you work with

**Organisation → Invitations**. Give each person the role they need (Viewer, Trader, Analyst, Operator, Admin,
RiskManager, Billing, or a role of your own). You can only give roles whose permissions you hold yourself. Then make a
second factor compulsory: **Organisation → Security policy → Require a second factor**.

## 3. Connect a terminal

**Organisation → Connect a terminal → Guided connection** (`/organisation/terminals/connect`). The wizard:

1. lists what you need (MetaTrader 5, a demo account, the Lascodia EA and the engine address it will call);
2. creates a single-use **enrollment token** — shown once — and offers a ready-made MT5 preset file holding it;
3. shows the exact MetaTrader 5 steps: the WebRequest allow-list entry, copying the EA, attaching it, loading the preset;
4. follows the terminal on the engine's side — token used, signed in, registered, first heartbeat — and turns green.

If it does not move, the wizard says why (for example *error 4060 — the allow-list entry is missing*, or *the engine
turned the terminal away: Real accounts are limited to House*). The [EA install guide](/docs/ea-install) has the details.

## 4. Open a live chart

**Chart** (`/chart-analysis`). Pick a symbol and a timeframe; prices, the order book ladder and your positions appear
live. Saving a layout ticks the last step of the checklist. The [user guide](/docs/user-guide) explains the chart.

## 5. Choose strategies

**Organisation → Strategy subscriptions**: subscribe your accounts to platform strategies (an account receives a
strategy's signals only through a subscription your organisation created), or add your own scripts.

## Want to look first?

The public **demo** (`/demo`, linked from the sign-in page when the platform runs it) shows the console's chart and
order book on **recorded** market data, replayed on a loop. It is labelled as recorded on every screen and cannot trade.

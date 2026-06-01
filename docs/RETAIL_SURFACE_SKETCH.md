# Retail-Facing Surface — Architectural Sketch

> Status: exploratory sketch. Not a commitment, not a PRD. Purpose: pressure-test
> whether a "retail trader" product can be layered on the existing Lascodia engine
> without forking the codebase or watering down the admin tooling.

## 1. Framing

The existing Lascodia stack is a **quant/algo infrastructure platform**:
ML training queues, optimization runs, drift detection, walk-forward analysis,
strategy generation, calibration snapshots, composite-ML policy knobs, etc.
The admin UI exposes ~50 feature areas, most of which are operator-facing.

A retail trader product is the inverse: **few decisions, strong guardrails, a
clear narrative for every action.** Most retail users cannot — and should not —
interact with `CompositeMLPolicyKnobPin` or `MLConformalCalibration`.

The proposed shape is therefore **not a pivot** but a **second surface** on top of
the same engine: a separate Angular app (or workspace project) consuming a curated
subset of the existing v1 controllers, plus a thin layer of new ones that wrap
engine primitives into retail-friendly verbs.

The honest value prop:

> "We won't promise you can't blow your account. We'll make it structurally hard
> to: enforced sizing, hard daily-loss circuit breakers, pre-trade checks, and a
> plan-before-you-click workflow."

## 2. What Already Exists That We Reuse

The engine domain already contains nearly every primitive a retail product needs.
The retail surface should be a **read/write subset** of these, never a re-implementation.

| Retail concept              | Existing engine primitive                                                          |
| --------------------------- | ---------------------------------------------------------------------------------- |
| "My account"                | `TradingAccount`, `BrokerAccountSnapshot`, `TradingAccountAuth`                    |
| "Connect my broker"         | `brokers/` controller surface, EA instance pairing (`EAInstance`)                  |
| "My risk profile"           | `RiskProfile` (per-symbol limits, max drawdown, max position)                      |
| "Daily kill switch"         | `KillSwitchController` + `kill-switches/` UI patterns                              |
| "Practice mode"             | `PaperTradingController`, `PaperExecution`                                         |
| "Place a planned trade"     | `Order`, `Position`, `TradeSignal`, `SignalAccountAttempt`                         |
| "Why did this trade close?" | `TradeRationale`, `PositionLifecycleEvent`, `LifecycleEventRationale`              |
| "How am I doing?"           | `StrategyPerformanceSnapshot`, `DrawdownSnapshot`, `AccountPerformanceAttribution` |
| "What's the market doing?"  | `MarketRegimeSnapshot`, `SentimentSnapshot`, `LivePrice`                           |
| "Pick a strategy"           | `Strategy`, `StrategyVersion` (Active only — never raw `MLModel`)                  |
| "Heads-up on news"          | `EconomicEvent`                                                                    |
| "Costs are honest"          | `TransactionCostAnalysis`, `RealisedCostProfile`                                   |

Nothing in this column requires new domain entities. Everything new lives in the
**API contract / UX layer**, not the domain.

## 3. The Four Retail Verbs

Reduce the surface area to four verbs. Every retail screen maps to one of them:

1. **Plan** — pre-trade analysis: pick a symbol, see regime + sentiment + news,
   draft a trade with stop/target/size pre-filled from the user's risk profile.
2. **Execute** — one-click submit a _planned_ trade. No naked "place order" form;
   every order must originate from a Plan object (server-enforced).
3. **Observe** — open positions, today's P&L, drawdown vs. cap, kill-switch state.
4. **Review** — closed trades with rationale, weekly performance card, what the
   risk engine intervened on.

That's it. No "advanced order ticket" mode in v1.

## 4. Topology

```
┌──────────────────────────────────────────────────────────────────┐
│  lascodia-trading-engine-retail-ui     (NEW Angular app)         │
│  - Plan / Execute / Observe / Review screens                     │
│  - Reuses @lascodia/shared-library for design tokens             │
│  - Auth: same JWT issuer, different audience claim "retail"      │
└────────────────────────┬─────────────────────────────────────────┘
                         │  HTTPS (v1 API + new /retail/* surface)
┌────────────────────────▼─────────────────────────────────────────┐
│  LascodiaTradingEngine.API                                       │
│  ┌───────────────────────────────┐  ┌──────────────────────────┐ │
│  │ Existing v1 controllers       │  │ NEW /retail/v1 controllers│ │
│  │ (admin / operator surface)    │  │ - PlanController          │ │
│  │ (untouched)                   │  │ - RetailAccountController │ │
│  │                               │  │ - RetailPerformanceCtrl   │ │
│  └───────────────────────────────┘  └──────────────────────────┘ │
│                         │                       │                │
│                         ▼                       ▼                │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ LascodiaTradingEngine.Application                            ││
│  │ - Existing handlers untouched                                ││
│  │ - NEW: Retail.PlanTrade, Retail.SubmitPlan,                  ││
│  │        Retail.GetDailyState, Retail.PreTradeCheck            ││
│  │ - These COMPOSE existing domain services; they don't bypass  ││
│  │   risk, kill-switch, or rationale logging.                   ││
│  └──────────────────────────────────────────────────────────────┘│
│                                  │                                │
│                                  ▼                                │
│  Domain (unchanged) + Infrastructure (unchanged)                  │
└──────────────────────────────────────────────────────────────────┘
```

Key property: **the retail API is a façade, not a bypass.** A retail order goes
through the same `Order` / `Position` / risk-check pipeline as an admin-placed
order; the retail layer only narrows the inputs and shapes the outputs.

## 5. The Net-New Bits

Only four things are genuinely new:

### 5.1 `Plan` aggregate (new domain entity)

```
Plan
  Id
  UserId, AccountId, Symbol, Timeframe
  Direction (Long | Short)
  Entry (Market | Limit @ price)
  StopLoss (price OR ATR multiple OR % of equity at risk)
  TakeProfit (price OR R-multiple)
  RiskAmount (computed: bounded by RiskProfile)
  Rationale (free text + tagged factors: regime, sentiment, news-window)
  Status (Draft | Ready | Submitted | Expired | Cancelled)
  ExpiresAt (default: end of session)
```

A `Plan` is the **only** way a retail user creates an `Order`. This is the
mechanism that makes "no fear of blowing the account" structurally true: the user
literally cannot place an unsized, unstopped trade — the form will not validate,
and the API will reject it.

### 5.2 Pre-trade check endpoint

`POST /retail/v1/plans/{id}/pre-check` — runs the same gauntlet a strategy signal
runs: risk profile budget remaining, daily-loss kill switch, open-position cap,
correlated-exposure cap, news-blackout window, spread sanity. Returns a structured
list of `(check, status, explanation)` tuples so the UI can show **why** something
is blocked, in plain language.

This is the single most important UX deliverable. Retail users tolerate "no" if
they understand why. They churn on silent failure.

### 5.3 Retail-friendly performance rollups

The existing `StrategyPerformanceSnapshot` and `AccountPerformanceAttribution`
are operator-grade. Wrap them in a `WeeklyScorecard` projection:

- This week's P&L (currency + R-multiples)
- Win rate, average win, average loss, expectancy
- Largest drawdown this week + recovery state
- What the risk engine blocked (count + reason histogram)
- One-line narrative: "You followed your plan on 8 of 9 trades."

### 5.4 Strategy "shelf" (curated)

Don't expose `StrategyController` directly. Expose a curated list:
`GET /retail/v1/strategies` returns only strategies where
`Strategy.Status == Active AND Strategy.RetailEligible == true AND
StrategyCapacity.RemainingSlots > 0`. New domain field: `Strategy.RetailEligible`
(default false). An operator must explicitly opt a strategy in.

A retail user "follows" a strategy → signals from that strategy create
pre-filled **Plans** (still requiring user confirmation in v1). They are not
auto-executed. Auto-follow is a v2 feature gated by KYC + capital threshold.

## 6. What We Explicitly Do _Not_ Do (v1)

- **No raw order ticket.** Every order comes from a Plan.
- **No leverage selector.** Leverage is bounded by `RiskProfile`, set once at
  onboarding, changeable only via cooldown.
- **No exposure of ML internals.** No drift charts, no calibration curves, no
  conformal intervals. These exist on the admin surface for a reason.
- **No social / copy-trading.** Regulatory and behavioral risk are both high.
- **No discretionary strategy editing.** Retail users pick from the shelf; they
  do not author `StrategyVariant`s.
- **No "predictions" framing.** The UI says "the model rates this setup B+ based
  on similar past setups." It never says "this trade will win."

## 7. Risk & Compliance Posture

This is the part that kills retail trading products. Flagging the load-bearing
items so they don't become discoveries during build:

- **Regulatory perimeter.** Offering execution to retail users in most
  jurisdictions requires a broker license, an introducing-broker arrangement, or
  a partnership with a licensed broker. The cleanest v1 path is **BYO-broker**:
  the user connects their existing broker account; Lascodia is a SaaS that talks
  to their account. This avoids us being the broker.
- **Promotional language.** "Without fear of blowing an account" is a claim that
  will not survive a compliance review in regulated markets. The retail copy must
  be reframed as process language ("enforced risk caps", "circuit breakers"),
  not outcome language.
- **Suitability / KYC.** Even BYO-broker, a hosted plan-and-execute layer will
  trigger suitability questions in EU/UK. Build the onboarding to capture this
  data even if v1 ships only in permissive jurisdictions.
- **Audit trail.** `TradeRationale` and `LifecycleEventRationale` already give us
  a regulator-defensible "why did this trade happen" log. Make sure every retail
  action writes to it; don't add a parallel log.

## 8. Phasing

A pragmatic build order, each phase ~independently shippable:

**Phase R1 — Read-only "co-pilot"** (lowest regulatory risk, fastest validation)

- New retail UI shows: account state, open positions, today's P&L, kill-switch
  state, weekly scorecard.
- User connects broker (existing `brokers/` flow).
- No order submission from retail UI. Plans can be drafted but not executed.
- Goal: validate that the curated lens is itself valuable.

**Phase R2 — Plan → Paper**

- `Plan` aggregate + pre-trade check.
- Plans can be submitted to **paper trading only** (`PaperExecution`).
- Weekly scorecard now includes paper trades.
- Goal: validate the workflow without real money.

**Phase R3 — Plan → Live (BYO-broker)**

- Pre-trade check is now blocking, not advisory.
- Live execution behind a per-account daily cap and a global per-user cap.
- Compliance + KYC onboarding gating live mode.

**Phase R4 — Curated strategy shelf**

- `Strategy.RetailEligible` flag + curation workflow on the admin UI.
- Follow-a-strategy → auto-populated Plans (user still confirms each one).

**Phase R5 — Auto-follow (gated)**

- Auto-execute strategy signals up to a capped notional, behind KYC + minimum
  capital + explicit opt-in with a cooldown.

## 9. Open Questions

The questions that need answers before this becomes a real plan:

1. **Jurisdiction first.** Which market do we want to be legal in on day one?
   That choice dictates broker partnerships, KYC vendor, and copy rules.
2. **Single broker or many?** Each new broker integration is weeks of work; the
   engine's `brokers/` abstraction helps but doesn't eliminate this.
3. **Pricing model.** Subscription, % of profits, spread markup, or free + paid
   strategy shelf? This affects which features are gated.
4. **Who curates the strategy shelf?** "Operator picks" doesn't scale; needs a
   defined promotion criterion (Sharpe floor, live track-record minimum, drawdown
   cap) before R4.
5. **What's the second-surface app — separate repo, Nx workspace project, or
   route-level split inside admin UI?** Recommendation: **separate app, shared
   design library** — the auth model, accessibility bar, and load profile differ
   too much to share a routing tree.

## 10. The One-Line Verdict

The engine is already 70% of a retail trading product; the missing 30% is mostly
**restraint** (hiding the operator surface) and **narrative** (turning structured
risk events into plain language). The biggest risks are regulatory and copy, not
engineering.

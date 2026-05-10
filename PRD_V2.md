# Lascodia Admin UI v2 — Product Requirements Document

|                            |                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Version**                | 2.0 (Draft)                                                                                                       |
| **Status**                 | Pending review                                                                                                    |
| **Date**                   | 2026-05-10                                                                                                        |
| **Supersedes**             | None — companion to [PRD.md](PRD.md) (v1)                                                                         |
| **Sister documents**       | [UPGRADE_PLAN.md](UPGRADE_PLAN.md) (v1 execution plan, complete), v2 execution plan (to be written from this PRD) |
| **Target engine version**  | Lascodia Trading Engine `main` as of 2026-05-10 (40 controllers, ~130 entities, ~190 workers)                     |
| **Target Angular version** | 20.x (upgrade from 19.2 is part of Phase 0)                                                                       |

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Problem statement](#2-problem-statement)
3. [Goals & non-goals](#3-goals--non-goals)
4. [Users, roles, and scenarios](#4-users-roles-and-scenarios)
5. [Scope: feature surfaces](#5-scope-feature-surfaces)
   - 5.1 [CompositeML Operator Console](#51-compositeml-operator-console)
   - 5.2 [ML Lifecycle Depth v2](#52-ml-lifecycle-depth-v2)
   - 5.3 [Strategy Discovery & Lifecycle v2](#53-strategy-discovery--lifecycle-v2)
   - 5.4 [Autonomous Mutation Controls](#54-autonomous-mutation-controls)
   - 5.5 [EA Live Control Plane](#55-ea-live-control-plane)
   - 5.6 [RBAC v1 + System Diagnostics](#56-rbac-v1--system-diagnostics)
   - 5.7 [Real-time Push Channel](#57-real-time-push-channel)
6. [Non-functional requirements](#6-non-functional-requirements)
7. [Design system & UX conventions](#7-design-system--ux-conventions)
8. [Operational requirements](#8-operational-requirements)
9. [Decisions log](#9-decisions-log)
10. [Success metrics](#10-success-metrics)
11. [Dependencies](#11-dependencies)
12. [Risks](#12-risks)
13. [Open questions](#13-open-questions)
14. [Out of scope](#14-out-of-scope)
15. [Glossary](#15-glossary)
16. [Appendix: feature surface ↔ engine endpoint mapping](#16-appendix-feature-surface--engine-endpoint-mapping)

---

## 1. Executive summary

The Lascodia Trading Engine has grown materially in two weeks: **+9 controllers, +80 endpoints, +54 domain entities, +43 background workers** since the v1 upgrade plan baseline. The Admin UI has matured into a solid foundation (Phases 0–5 of the v1 plan are complete, plus the trader-floor wave) but the engine's new capabilities — CompositeML observability, ML lifecycle depth, LLM strategy proposals, auto-tune review, EA control plane, RBAC, system logs — are largely **invisible to operators**. Operators still leave the UI for `psql` and Docker logs to diagnose CompositeML behavior, review drift, or manage roles.

Admin UI **v2** closes that gap. It introduces seven new feature surfaces, finishes the production-grade operational posture (push channel, codegen API client, comprehensive tests, Lighthouse/bundle CI gates, staging deploy), and lifts the foundation to Angular 20 to unblock long-deferred component testing.

**Headline outcome:** an operator can run the full engine — generation, training, promotion, retirement, kill-switching, role management — without ever opening a terminal.

**Estimated scope:** 12 weeks single-developer, 6–8 weeks with parallelization, sequenced across eight phases (one foundation phase, six feature waves, one hardening phase).

---

## 2. Problem statement

### 2.1 The engine has outgrown its UI

The engine now exposes ~180 endpoints across 40 controllers. The admin UI surfaces approximately **55% of the endpoint catalogue**, and the unsurfaced portion is disproportionately the **highest-leverage diagnostic surface** — the parts an operator most needs when something goes wrong.

Specifically, the following engine investments are largely or entirely invisible in the UI today:

- **CompositeML policy lifecycle** (13 endpoints): snapshots, diffs, layer/trainer skill weighting, catalogue drift, gate cutover, cold-start diagnostics
- **ML model lifecycle depth**: lifecycle event logs, feature-importance consensus, overfit watchlist, drift reports across detector families, symbolic features pipeline (genetic programming)
- **Strategy discovery automation**: LLM proposal review, variants A/B testing, capacity profiles, allocation weights, rejection distributions, templates
- **Auto-tune control plane**: proposal review, per-knob safety-gate configuration
- **EA live control**: symbol-spec refresh, hot-reload config, signal feedback feed, order-book snapshots
- **RBAC**: engine now has it; UI has no admin surface
- **System logs query**: tail-with-filters endpoint replaces `docker logs | grep`
- **Operator audit trail depth**: PromotionReviewSnapshot, ReflectionEntry, LifecycleEventRationale, LlmInvocation tables

### 2.2 Operators leave the UI to do their job

Today's effective operator workflow includes:

- `psql` queries against `CompositeMLPolicySnapshot` to diff active vs prior policies
- `docker logs lascodia-engine | grep "Drift"` to spot drift alerts
- Manual JSON edits to `ml-models.service.ts` when surfacing a new diagnostic
- SSH into the staging host to refresh EA symbol specs
- Manual `INSERT INTO operator_role` to add an admin

Each detour erodes trust in the UI and creates a permanent two-tool dependency. The UI cannot be the operator's home if the operator needs a second tool for 30% of daily work.

### 2.3 Operational posture is incomplete

The v1 plan landed CI, Docker, basic E2E, Sentry, web vitals, and feature flags — but several gates remain open:

- Test:source ratio is **14 specs / ~300 source files** (sparse)
- Component-test scaffolds are blocked by Angular 19.2 / Analog plugin incompatibility
- Bundle size is not tracked per-PR
- No Lighthouse gate in CI
- No staging deploy step
- Storybook is configured but dormant (no stories)
- API DTOs are hand-maintained and drift with the engine
- Real-time streams are simulated by polling at 5–30s intervals

---

## 3. Goals & non-goals

### 3.1 Goals

| #   | Goal                                                     | Rationale                                            |
| --- | -------------------------------------------------------- | ---------------------------------------------------- |
| G1  | Surface ≥ 95% of operator-relevant engine endpoints      | UI must be the operator's home                       |
| G2  | Zero `psql` / SSH / `docker logs` required for daily ops | Eliminate two-tool dependency                        |
| G3  | Production-grade operational posture                     | Confidence to deploy + maintain                      |
| G4  | Real-time push for hot data                              | Reduce engine polling load + improve perceived speed |
| G5  | Lighthouse a11y ≥ 95, perf ≥ 85 per route                | Maintain v1's a11y baseline; tighten perf            |
| G6  | Codegen'd typed API client                               | Stop hand-maintained DTO drift                       |
| G7  | Component-level test coverage ≥ 30% on shared primitives | Unblock confident refactors                          |
| G8  | RBAC enforcement (UI gates visibility; server enforces)  | Multi-operator readiness                             |

### 3.2 Non-goals (in this release)

| #   | Non-goal                               | Reason                                                   |
| --- | -------------------------------------- | -------------------------------------------------------- |
| N1  | Mobile-native apps                     | Carried from v1 — out of scope                           |
| N2  | Multi-tenancy / customer-facing portal | This is an admin/operator console, not a SaaS            |
| N3  | TradingView-class charting             | Defer to TradingView/Grafana embeds                      |
| N4  | i18n / localization                    | English-only; revisit only if a stakeholder asks         |
| N5  | Offline-first UX                       | Admin actions without engine reachability are misleading |
| N6  | ML SHAP / explainability UI            | Engine endpoint doesn't exist; tracked as engine work    |
| N7  | MFA / SSO                              | Engine endpoint doesn't exist; tracked as engine work    |
| N8  | WebSocket order-book streaming         | Engine sends batch POSTs from EA; SignalR fan-out only   |
| N9  | Replace existing v1 surfaces           | v1 features remain; v2 extends                           |

---

## 4. Users, roles, and scenarios

### 4.1 Roles

| Role                    | Description                                                                                                                                                                      | Granted via                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Operator**            | Default authenticated user. Can monitor, approve/reject signals, toggle kill switches with reason, trigger training/optimization, promote/rollback ML models, manage strategies. | Default on registration                                    |
| **Admin**               | Operator + can grant/revoke roles, edit auto-tune safety-gate config, push EA config, manage feature flags.                                                                      | Granted by another Admin via `/admin/operator-roles/grant` |
| **Viewer** _(optional)_ | Read-only across all surfaces. Buttons that mutate are hidden.                                                                                                                   | Granted by Admin                                           |

> **RBAC model:** Server is authoritative. UI **hides** controls the user lacks roles for (improves UX, removes "permission denied" surprise). Server enforces; UI never trusts itself. 403 responses surface as friendly toast.

### 4.2 Primary persona: Solo Operator (current state)

Single technical operator running the engine end-to-end. Senior developer; deep familiarity with the strategy-generation, ML-training, and EA loops; comfortable in the terminal but should not need to be. Currently spends ~30% of operational time outside the UI; v2 target is < 5%.

### 4.3 Secondary persona: Reviewing Admin (future state)

A second operator added when the engine moves from single-operator to team operation. RBAC v1 (Phase 6) is the prerequisite for this persona to exist.

### 4.4 User scenarios (day in the life)

**Scenario S1 — Morning check-in (8 AM)**

1. Open admin UI, see app shell with: paper-mode banner (if active), kill-switch banner (if engaged), offline banner (if engine unreachable), rate-limit strip
2. Glance at Dashboard: account equity, daily P&L, exposure, pending signals
3. Check System Health → all 190+ workers green
4. Check EA Instances → heartbeat fresh, symbols owned, no reassignment
5. Skim System Logs → no `Error`-level events overnight
6. Done in 2 minutes

**Scenario S2 — Trading day signal flow**

1. Pending Signals panel polls every 15s (push after Phase 7); new approved candidate appears
2. Operator clicks signal → review side panel (DSL, ML score, MCC, lineage)
3. Approve / reject with reason → audit-trail entry created
4. If approved, signal flows to EA via `/pending-execution`; position opens; positions page updates within seconds

**Scenario S3 — Investigating a CompositeML drop in signal volume (NEW in v2)**

1. Operator notices `pending_signals` count dropped 80% since yesterday
2. Open CompositeML → Catalogue Drift → see "Layer EntryGate drop alert at 14:32"
3. Click into the alert → time-series shows trainer SpA contributing 0% since 14:30
4. Open Trainer Skill panel → SpA suppressed by auto-evaluator due to recent live underperformance
5. Operator reviews 7-day Sharpe, decides suppression is correct → leaves it
6. Documents reasoning in ReflectionEntry (audit) → returns to monitoring
7. **Total time: 5 minutes. v1 equivalent: 30+ minutes in `psql` + log files.**

**Scenario S4 — LLM proposal review (NEW in v2)**

1. Operator opens Strategies → LLM Proposals (Pending tab)
2. Reviews proposal DSL inline + LLM invocation context (model, prompt, response)
3. Validates structure looks sensible → clicks Promote → strategy created in Paused state
4. Backtest preview run from strategy detail → results look good → activate
5. **Total time: 3 minutes. v1 equivalent: not possible — proposals invisible.**

**Scenario S5 — Adding a second operator (NEW in v2)**

1. Admin opens Operator Roles page
2. Looks up new operator's TradingAccount
3. Grants Operator role → audit-trail entry created
4. New operator logs in → sees Dashboard + role-permitted features only

**Scenario S6 — Approving an auto-tune proposal (NEW in v2)**

1. Header pill shows "3 proposals pending review"
2. Operator clicks → Auto-Tune Proposals page
3. Reviews proposed knob delta + rationale + expected impact
4. Apply → engine atomically updates config + appends audit entry
5. Watches the relevant metric for one cycle; rolls back if regressed (rollback endpoint already exists)

---

## 5. Scope: feature surfaces

Each feature surface below has:

- **Description**: what it is and why
- **User stories**: in "as an X, I want Y so that Z" form
- **Functional requirements (FR)**: numbered, testable
- **Acceptance criteria (AC)**: per-surface gates
- **Engine dependencies**: endpoints/entities consumed
- **Phase**: which execution-plan phase delivers it

### 5.1 CompositeML Operator Console

**Phase:** 1 (2 weeks) — highest-leverage untapped surface

#### 5.1.1 Description

A dedicated CompositeML section in the sidebar (or under ML Models) exposing the 13 new `/composite-ml/*` endpoints. Replaces today's "open `psql` and join four tables" workflow for diagnosing the policy → layer → trainer → catalogue cascade.

#### 5.1.2 User stories

- US-1.1 As an operator, I want to see all Active policies and their per-knob deltas since last activation so I understand what the engine has tuned recently.
- US-1.2 As an operator, I want to diff two policy snapshots so I can audit auto-tune behavior or a hand-applied change.
- US-1.3 As an operator, I want to see per-layer health over a lookback window so I can spot a layer dropping cycles.
- US-1.4 As an operator, I want to see (layer, partition tier) skill snapshots and override a layer's weight so I can hand-tune the auto-arbitration when I disagree.
- US-1.5 As an operator, I want to suppress or enable a specific trainer so I can halt promotion attempts from a misbehaving trainer.
- US-1.6 As an operator, I want a catalogue-drift summary so I can spot which catalogue entries are decaying.
- US-1.7 As an operator, I want to flip a layer's gate cutover so I can roll cold-start catalogue layers forward or back during incidents.
- US-1.8 As an operator, I want to see the cold-start donor selection so I understand which historical similar pairs the engine is borrowing from.
- US-1.9 As an operator, I want to see known-bad knob combinations highlighted so I notice misconfigurations before they regress trading.

#### 5.1.3 Functional requirements

- **FR-1.1** **Active Policies page** — list of CompositeML policy snapshots in Active state, with per-knob delta columns showing change vs prior snapshot. Filter by symbol/timeframe/layer. Click row → detail.
- **FR-1.2** **Policy Snapshot detail** — full snapshot inspector: knobs, status, activated-at, activator, prior-snapshot link, full ancestry chain rendered as a vertical timeline.
- **FR-1.3** **Policy Diff view** — select two snapshots from the list (multi-select or "compare with prior"); render a side-by-side table with diff highlighting, magnitude-normalized.
- **FR-1.4** **Layer Health dashboard** — for each registered CompositeML layer (current count: ~12): card showing enabled-fraction, cycle counts, config-hash stability, last cycle timestamp. Sparkline per layer over selectable lookback (1h / 6h / 24h / 7d).
- **FR-1.5** **Layer Skill panel** — table of (layer, partition tier) skill snapshots: layer name, tier, current weight, manual override status. Inline action: "Override to MaxWeight" / "Override to MinWeight" / "Clear override". Override requires a reason; reason is logged to audit trail.
- **FR-1.6** **Trainer Skill panel** — same shape, with "Suppress" / "Enable" / "Clear override" actions.
- **FR-1.7** **Catalogue Drift summary page** — table of catalogue entries with latest drift snapshot, prior snapshot, delta, drop-alert flag. Sort by drop-alert + delta descending.
- **FR-1.8** **Catalogue Drift history** — drill into one (layer-key, scope) → time-series chart of drift over the last N days; flag the points where drop-alert fired.
- **FR-1.9** **Gate Cutover toggle** — per-layer switch showing current state (Ledger / Legacy) with description and ReturnLedgerCount flag. Toggle action requires confirmation + reason.
- **FR-1.10** **Cold-Start Report page** — per-layer thresholds vs observed state; below-threshold rows highlighted. Adjacent panel: donor selection — per-(symbol, timeframe) donor candidates with similarity scores.
- **FR-1.11** **Options Health audit card** — on the CompositeML overview page, render warnings for known-bad knob combinations (e.g. double-count drawdown + Calmar) flagged by `/composite-ml/options-health`.

#### 5.1.4 Acceptance criteria

- AC-1.A All 13 `/composite-ml/*` endpoints have at least one consuming UI surface
- AC-1.B Manual overrides write to audit trail with operator + reason; visible in Audit Trail page
- AC-1.C Layer Health updates every 30s (polling, or push after Phase 7)
- AC-1.D Each panel has a "What does this mean?" inline help link pointing to the relevant ADR (014, 015, 016, 017, 018, 019)
- AC-1.E All destructive actions (override, gate flip) gated behind confirm dialog with required reason

#### 5.1.5 Engine dependencies

| Endpoint                                      | Method | Notes                           |
| --------------------------------------------- | ------ | ------------------------------- |
| `/composite-ml/active-policies`               | GET    | List + per-knob deltas          |
| `/composite-ml/policy-snapshots/diff`         | GET    | Two-snapshot diff               |
| `/composite-ml/policy-lineage/{id}`           | GET    | Ancestry walk                   |
| `/composite-ml/layer-health`                  | GET    | Lookback window param           |
| `/composite-ml/layer-skill-snapshots`         | GET    | Filter symbol/timeframe/layerId |
| `/composite-ml/layer-skill-manual-override`   | POST   | Required: reason                |
| `/composite-ml/trainer-skill-snapshots`       | GET    |                                 |
| `/composite-ml/trainer-skill-manual-override` | POST   | Required: reason                |
| `/composite-ml/catalogue-drift/summary`       | GET    |                                 |
| `/composite-ml/catalogue-drift/history`       | GET    | Layer-key + scope               |
| `/composite-ml/cold-start-report`             | GET    |                                 |
| `/composite-ml/donor-selection`               | GET    |                                 |
| `/composite-ml/options-health`                | GET    |                                 |
| `/composite-ml/gate-cutover/status`           | GET    |                                 |
| `/composite-ml/gate-cutover`                  | POST   | Per-layer flip                  |

---

### 5.2 ML Lifecycle Depth v2

**Phase:** 2 (1.5 weeks)

#### 5.2.1 Description

Extends the existing ML Models pages with the new lifecycle, feature-importance, overfit-watchlist, drift, and symbolic-features endpoints. Eliminates the v1 Phase 3 engine-gap note about no SHAP/explainability — the engine doesn't have SHAP but does now have cross-architecture feature-importance consensus.

#### 5.2.2 User stories

- US-2.1 As an operator, I want to see every lifecycle event for a model in a timeline so I can audit why and when it was promoted, superseded, or retired.
- US-2.2 As an operator, I want to see which features matter most across architectures so I can prune the feature set.
- US-2.3 As an operator, I want to see which active models are overfit (CV Sharpe materially exceeds live Sharpe) so I can rotate them out.
- US-2.4 As an operator, I want to see drift alerts grouped by detector family so I can distinguish covariate shift from distribution drift.
- US-2.5 As an operator, I want to manage symbolic features (promote, retire) so the genetic-programming pipeline picks them up.
- US-2.6 As an operator, I want to know whether V6 OrderBook feature slots are being used by trained models so I know whether to keep ingesting DOB data.

#### 5.2.3 Functional requirements

- **FR-2.1** **Lifecycle Timeline tab** on `/ml-models/:id` — render `/ml-model/{id}/lifecycle` as a vertical timeline. Each entry: timestamp, event type (Activation / Supersession / DegradationRetirement / Rollback), reason/rationale text, metric snapshot (Sharpe, accuracy, etc.) shown as inline mini-grid.
- **FR-2.2** **Feature Importance panel** on `/ml-models/:id` — cross-architecture consensus chart (horizontal bar by importance, top N adjustable). Tooltip shows per-architecture contribution. Fallback message if consensus not yet computed: "MRMR top-25 shown" with the MRMR list.
- **FR-2.3** **Overfit Watchlist page** at `/ml-models/overfit-watchlist` — table of active models with cv-sharpe / live-sharpe / gap columns, sorted by gap descending. Row click → model detail.
- **FR-2.4** **Drift Report page** at `/ml-models/drift-report` — paged list of drift alerts. Filter chips by detector family (Adwin, CUSUM, CovariateShift, MultiScale, DriftAgreement). Side drawer per alert: metrics, threshold context, model linked, suggested action.
- **FR-2.5** **Symbolic Features page** at `/ml-models/symbolic-features` — tabbed view (Candidate / Promoted / Retired / Rejected). Each row: feature expression (truncated, hover full), validation status, mining timestamp. Actions: Promote (Candidate → Promoted), Retire (Promoted → Retired). Each row click → side drawer with decay history chart from `/ml-model/symbolic-features/{id}/decay-history`.
- **FR-2.6** **V6 OrderBook utilization diagnostic** — small card on Training Lab page: percentage of recently trained models that reference feature slots 52–56 (DOB features). Color-coded threshold (green > 30%, yellow 10–30%, red < 10%).
- **FR-2.7** **Available Architectures filter** — Training Lab trigger form populates the architecture dropdown from `/ml-model/training/available-architectures` (replaces hardcoded list); disables architectures marked unavailable on this host with a tooltip explaining why.
- **FR-2.8** **Drift context on training run detail** — MLTrainingRun.hyperparameterAuditTrail JSON rendered as collapsible tree on the run detail page.

#### 5.2.4 Acceptance criteria

- AC-2.A Operator can answer "why was model X retired?" from the lifecycle timeline alone
- AC-2.B Operator can identify the top-3 overfit active models in < 30 seconds
- AC-2.C Symbolic-features promote/retire actions write to audit trail with reason
- AC-2.D V1 Phase 3 engine-gap note about no-SHAP is removed; replaced with feature-importance consensus chart

#### 5.2.5 Engine dependencies

`/ml-model/{id}/lifecycle`, `/feature-importance`, `/overfit-watchlist`, `/drift-report`, `/symbolic-features`, `/symbolic-features/{id}/promote`, `/symbolic-features/{id}/retire`, `/symbolic-features/{id}/decay-history`, `/v6-orderbook-feature-utilization`, `/training/available-architectures`

---

### 5.3 Strategy Discovery & Lifecycle v2

**Phase:** 3 (2 weeks)

#### 5.3.1 Description

Major expansion of the Strategies feature. Surfaces LLM proposals, A/B variants, capacity profiles, allocation weights, rejection diagnostics, templates, and parameter-schema-driven forms.

#### 5.3.2 User stories

- US-3.1 As an operator, I want to review LLM-generated proposals so I can promote good ones and reject bad ones with auditable reasoning.
- US-3.2 As an operator, I want to see A/B variants on a base strategy so I can pick a winner and promote it.
- US-3.3 As an operator, I want to see a strategy's capacity profile (AUM vs edge) so I can size it appropriately.
- US-3.4 As an operator, I want to see the meta-allocator's current weights so I know what the engine is favoring.
- US-3.5 As an operator, I want to know why a strategy isn't generating signals (which gate is rejecting) so I can fix it or accept it.
- US-3.6 As an operator, I want to save a working strategy as a template and apply it across multiple symbols so I scale a good idea efficiently.
- US-3.7 As an operator, I want the strategy form to know the parameter schema for each strategy type so I'm not editing raw JSON.

#### 5.3.3 Functional requirements

- **FR-3.1** **LLM Proposals page** at `/strategies/llm-proposals` — tabbed list (Pending / DslInvalid). Each row: proposed name, symbol/timeframe, strategy type, mined-at, source LLM model. Detail drawer: full DSL preview (renders inside the existing DSL builder in read-only mode), LLM invocation audit (model, prompt hash, response excerpt from `LlmInvocation` table), validation errors if DslInvalid.
- **FR-3.2** **Promote LLM proposal** — action on the proposal detail; opens confirm dialog; on confirm, posts `/strategy/llm-proposals/{id}/promote`; on success, route to the newly created strategy detail page (Paused state).
- **FR-3.3** **Variants tab** on strategy detail — list shadow variants attached to this base strategy with their override deltas, shadow performance metrics, days-running. Action: "Promote variant" (copies overrides onto parent, retires variant) with confirm.
- **FR-3.4** **Capacity Profile card** on strategy detail — chart of AUM (x-axis) vs expected edge (y-axis) with current allocation marker. Source: `/strategy/{id}/capacity-profile`.
- **FR-3.5** **Allocation Weights page** at `/strategies/allocation` — current weights across active portfolio. Tabs: bar chart by strategy, donut (categorical), time-series (last 24h). Tooltip shows throttle count per strategy.
- **FR-3.6** **Rejection Distribution drawer** — button "Why no signals?" on strategy detail; opens drawer with per-gate rejection counts (last 7 days) from `/strategy/{id}/rejection-distribution`. Each gate is a bar; click bar → tooltip with example rejected signals (timestamp + reason text).
- **FR-3.7** **Rejection Summary page** at `/strategies/rejections` — fleet-wide aggregate: which gates are dropping most signals across all strategies. Sortable.
- **FR-3.8** **Strategy Templates list page** at `/strategies/templates` — saved templates with metadata (name, source strategy, created-at, last-applied). Actions: Apply (opens symbol/timeframe multi-picker → applies in single round-trip via `/strategy/templates/apply`), Delete.
- **FR-3.9** **Save-as-Template action** on strategy detail — opens dialog requesting template name; posts to `/strategy/templates`.
- **FR-3.10** **Parameter-schema-driven form** — strategy form v3: when strategyType is one of the schema-supported types (RSIReversion, MovingAverageCrossover, BollingerBandReversion, MomentumTrend, BreakoutScalper), render typed controls (number, select, range) from `/strategy/parameter-schema/{strategyType}` instead of the generic JSON textarea. Fall back to JSON textarea for types without schema. DSL builder remains the alternative for RuleBased / LlmProposal types.
- **FR-3.11** **Promotion-readiness extended** — extend the existing promotion-readiness card to render PromotionReviewSnapshot + ReflectionEntry data when present.

#### 5.3.4 Acceptance criteria

- AC-3.A Operator can promote an LLM proposal to a live (Paused) strategy in < 3 clicks
- AC-3.B Allocation weights page renders without errors when fleet has 50+ active strategies
- AC-3.C Rejection distribution drawer answers "why isn't this strategy generating signals?" without operator opening any other tool
- AC-3.D Apply Template action handles up to 20 symbols × 4 timeframes in a single round-trip
- AC-3.E Parameter-schema form for RSIReversion preserves backward-compat with strategies created via JSON form (round-trips without data loss)

#### 5.3.5 Engine dependencies

`/strategy/llm-proposals`, `/strategy/llm-proposals/{id}/promote`, `/strategy/{id}/variants`, `/strategy/variants/{variantId}/promote`, `/strategy/{id}/capacity-profile`, `/strategy/allocation-weights`, `/strategy/{id}/rejection-distribution`, `/strategy/rejection-summary`, `/strategy/templates` (GET/POST/DELETE), `/strategy/templates/apply`, `/strategy/parameter-schema/{strategyType}`, `LlmInvocation` audit table, `PromotionReviewSnapshot`, `ReflectionEntry`

---

### 5.4 Autonomous Mutation Controls

**Phase:** 4 (1 week)

#### 5.4.1 Description

Operator review surface for the auto-tune subsystem. Engine generates knob-change proposals; operator reviews, applies, or rejects, and configures which knobs are eligible for autonomous apply.

#### 5.4.2 User stories

- US-4.1 As an operator, I want to review auto-tune proposals before they apply so a misbehaving auto-tuner can't take the system down.
- US-4.2 As an admin, I want to configure which knobs the engine can autonomously tune (and within what bounds) so trusted knobs flow without review while sensitive knobs always pause for human approval.
- US-4.3 As an operator, I want a header pill showing pending proposal count so I notice when review is needed.

#### 5.4.3 Functional requirements

- **FR-4.1** **Auto-Tune Proposals page** at `/auto-tune` — list filtered by status (default Pending). Columns: knob, current value, proposed value, delta %, rationale (truncated), created-at. Row click → detail drawer.
- **FR-4.2** **Proposal detail drawer** — full rationale text, expected-impact estimate, source (which evaluator generated it), age. Actions: Apply (confirm + reason), Reject (confirm + reason).
- **FR-4.3** **Apply action** — POST `/auto-tune/proposals/{id}/apply`; engine atomically updates config + appends audit. On success, refresh list + show toast.
- **FR-4.4** **Reject action** — POST `/auto-tune/proposals/{id}/reject` with rationale; on success, refresh list + show toast.
- **FR-4.5** **Auto-Apply Config editor** at `/auto-tune/auto-apply-configs` (Admin role only) — table of per-knob configs with: knob key, enabled, max-delta-per-cycle, min-observation-window, max-applies-per-day, requires-review flag, last-modified-by, last-modified-at. Inline edit panel per row. Save uses `PUT /auto-tune/auto-apply-configs/{key}`.
- **FR-4.6** **Delete auto-apply config** — Admin-only action; soft-deletes via `DELETE /auto-tune/auto-apply-configs/{key}` with confirm.
- **FR-4.7** **Header pill** — count of pending proposals; visible to Operator role and up; click navigates to Proposals page. Polls every 60s (or push after Phase 7).
- **FR-4.8** **Proposal history view** — toggle "Show all" to include Applied / Rejected / Expired rows. Filter by knob key, reviewer, date range. Export to CSV.

#### 5.4.4 Acceptance criteria

- AC-4.A Operator can apply or reject any pending proposal in < 30 seconds
- AC-4.B Apply / Reject actions write to audit trail with reviewer + reason
- AC-4.C Auto-Apply Config edit is gated to Admin role (Operator sees read-only view)
- AC-4.D Header pill never shows stale count older than 60s under normal operation

#### 5.4.5 Engine dependencies

`/auto-tune/proposals`, `/auto-tune/proposals/{id}/apply`, `/auto-tune/proposals/{id}/reject`, `/auto-tune/auto-apply-configs` (CRUD)

---

### 5.5 EA Live Control Plane

**Phase:** 5 (1.5 weeks)

#### 5.5.1 Description

Extends the existing EA Instances page from "monitor only" to "monitor + control". Adds order-book live view and candle coverage diagnostics. The operator can manage the EA fleet from the UI without SSH.

#### 5.5.2 User stories

- US-5.1 As an operator, I want a detailed EA page so I can see heartbeat history, owned symbols, recent commands, and reconciliation status in one place.
- US-5.2 As an operator, I want to refresh an EA's symbol specs without restarting it so I pick up new pairs without trading downtime.
- US-5.3 As an operator, I want to push hot-reloaded safety config to an EA so I can tighten lot-size caps mid-session.
- US-5.4 As an operator, I want to see the signal-feedback feed (deferred / dropped / expired) so I diagnose why EAs aren't executing signals I approved.
- US-5.5 As an operator, I want to see the live order book so I can sanity-check liquidity before a large position.
- US-5.6 As an operator, I want to see candle coverage gaps so I know when historical backfill is incomplete.
- US-5.7 As an operator, I want to see incremental position deltas so I can debug mid-position changes.

#### 5.5.3 Functional requirements

- **FR-5.1** **EA detail page** at `/ea-instances/:id` — heartbeat history (last 24h timeline), owned-symbols table, recent commands (last 50), reconciliation status, version + build info.
- **FR-5.2** **Refresh Symbol Specs action** — button on EA detail + per-EA-row action in list; PUT `/ea/symbol-specs/refresh`; confirms; toast on success.
- **FR-5.3** **EA Config push panel** — collapsible section on EA detail. Form fields mirror the EACommand update-config payload (lot-size cap, slippage tolerance, max positions, etc.). Submit posts `/ea/commands/update-config`. Zero values omitted (engine treats as "leave unchanged").
- **FR-5.4** **Signal Feedback page** at `/ea-instances/signal-feedback` — paged feed of EA signal feedback events. Filters by event type (Deferred / Dropped / Expired), symbol, EA instance, date range. Detail row shows signal ID, reason, EA instance, timestamp.
- **FR-5.5** **Order Book live view** at `/market-data/order-book/:symbol` — depth ladder (5–10 levels each side), polled every 2s (push after Phase 7). Sub-page within Market Data.
- **FR-5.6** **DOB recent history** — toggle on the order-book page; renders `/market-data/order-book/recent` as a time × price heatmap (echarts heatmap).
- **FR-5.7** **Candle Coverage / Watermarks** page at `/market-data/coverage` — table per (symbol, timeframe): latest candle timestamp, expected timestamp (based on session calendar), gap, coverage % over last 7 days. Row click → drill-in chart showing gap distribution.
- **FR-5.8** **Position Delta feed** on Positions page — collapsible "Recent changes" panel rendering incremental position deltas (lot adjusted, partial close, stop modified) from the position-delta stream.

#### 5.5.4 Acceptance criteria

- AC-5.A Operator can push a config change to a specific EA without SSH
- AC-5.B Order-book view renders without jank for 10 update cycles (2s polling)
- AC-5.C Signal-feedback page renders 1000+ events without UI lock-up (virtualized list)
- AC-5.D Coverage page surfaces gaps within 1 minute of them occurring

#### 5.5.5 Engine dependencies

`/ea/instances`, `/ea/instances/{id}` (detail to be added if not existing), `/ea/symbol-specs/refresh`, `/ea/commands/update-config`, `/ea/signal-feedback`, `/market-data/order-book/latest/{symbol}`, `/market-data/order-book/recent`, `/market-data/candle/watermarks`, `/market-data/candle/coverage`, `/ea/positions/delta`

---

### 5.6 RBAC v1 + System Diagnostics

**Phase:** 6 (1 week)

#### 5.6.1 Description

Combines the RBAC management surface with three diagnostic surfaces (System Logs, Worker Override-Knobs reference, Defaults-Calibration report, Drawdown Recovery history) that share the "operator self-service introspection" theme.

#### 5.6.2 User stories

- US-6.1 As an admin, I want to grant and revoke operator roles so I can onboard a second operator.
- US-6.2 As an operator, I want to know my current effective roles so I understand what I can and can't do.
- US-6.3 As an operator, I want to tail system logs with filters so I diagnose issues without SSH.
- US-6.4 As an operator, I want to see the override-knob allow-list per worker so I don't have to grep CLAUDE.md.
- US-6.5 As an operator, I want to see the defaults-calibration report so I see whether engine-side floor recommendations differ from current values.
- US-6.6 As an operator, I want to see historical drawdown so I understand the recovery trajectory after a drawdown event.

#### 5.6.3 Functional requirements

- **FR-6.1** **Operator Roles page** at `/admin/operator-roles` (Admin role only) — table of role grants. Columns: TradingAccount, role, granted-by, granted-at, scope. Actions: Grant (Admin only — opens modal with account picker + role select), Revoke (confirm with reason).
- **FR-6.2** **Effective roles indicator** — header avatar dropdown shows current operator's roles + scope. Refreshes on `/auth/me` poll.
- **FR-6.3** **Visibility-gated UI** — destructive actions (kill-switch, rollback, promote, auto-tune apply, role grant/revoke) **hidden** when current user lacks role. UI checks via FeatureFlagsService.hasRole(...).
- **FR-6.4** **403 handler** — global HTTP error interceptor catches 403; emits friendly toast: "Insufficient role: requires X to perform this action."
- **FR-6.5** **System Logs page** at `/system-logs` — extends the existing system-logs feature. Live-tail mode (polls 2s); pause toggle; filters: level (Trace/Debug/Info/Warn/Error/Fatal), category, free-text search; result limit selector (100 / 500 / 2000). Copy-selected-lines action.
- **FR-6.6** **Worker Override-Knobs reference** at `/admin/worker-override-knobs` — table per worker: worker name, category, override-knob allow-list (chips). Click chip → opens engine-config editor pre-filtered to that knob.
- **FR-6.7** **Defaults-Calibration report** — new tab on the existing Calibration page (Recommended Defaults v2). Renders `/health/defaults-calibration` as a table: knob, current value, recommended value, delta, recommendation rationale.
- **FR-6.8** **Drawdown Recovery history** — new chart on the existing Drawdown page rendering `/drawdown-recovery/history` (paged); time-series of drawdown depth + recovery mode bands.

#### 5.6.4 Acceptance criteria

- AC-6.A Admin can grant + revoke a role in < 1 minute
- AC-6.B Operator without Admin role sees no Grant button on Operator Roles page
- AC-6.C 403 toast renders for every server-side denied action (verified via Playwright with mocked 403 responses)
- AC-6.D System Logs live-tail does not leak memory over 1 hour of continuous tailing (max retained 5000 lines)
- AC-6.E V1 "drawdown history is an engine-side gap" note is removed from the Drawdown page

#### 5.6.5 Engine dependencies

`/admin/operator-roles` (GET/grant/revoke), `/auth/me` (or equivalent), `/system/logs`, `/health/worker-override-knobs`, `/health/defaults-calibration`, `/drawdown-recovery/history`

---

### 5.7 Real-time Push Channel

**Phase:** 7 (2 weeks; engine collaboration required)

#### 5.7.1 Description

Migrates hot streams from polling to SignalR push. Reduces engine load, improves perceived UI speed, and enables sub-second updates for positions, prices, signals, and system logs.

#### 5.7.2 User stories

- US-7.1 As an operator, I want positions P&L to update in real time so I see profit/loss tick by tick.
- US-7.2 As an operator, I want approved signals to appear instantly so I can act on them faster than the EA polls.
- US-7.3 As an operator, I want the kill-switch banner to flip the moment another admin toggles it so we don't double-act on stale state.
- US-7.4 As an operator, I want a connection-health indicator so I know when I'm on push vs fallback polling.

#### 5.7.3 Functional requirements

- **FR-7.1** **Engine-side: SignalR hub** at `/realtime/hub`. Channels: `positions.pnl`, `prices`, `signals.pending`, `signals.approved`, `kill-switch`, `paper-mode`, `rate-limit`, `system-logs`.
- **FR-7.2** **UI-side: complete `core/realtime/` SignalR client** — connect on layout init, reconnect with exponential backoff on disconnect, message routing into signal stores.
- **FR-7.3** **Fallback to polling** when SignalR connection drops. Connection state tracked in a signal; emit "fallback" status.
- **FR-7.4** **Dashboard hot widgets migrated to push** — equity ticker, daily P&L (delta-applied from positions), pending signals badge, kill-switch banner.
- **FR-7.5** **System Logs migrated to push** for live-tail mode (replaces 2s polling).
- **FR-7.6** **Positions page** — open positions P&L migrated to push.
- **FR-7.7** **Connection-health indicator** — small dot in header: green (push connected), yellow (reconnecting), red (fallback polling). Click → reveals status + last reconnect attempt timestamp.
- **FR-7.8** **Polling intervals halved** on pages where push isn't viable but hot data benefits (e.g. EA heartbeat 15s → 10s).

#### 5.7.4 Acceptance criteria

- AC-7.A Positions P&L updates within 1s of engine tick under good connection
- AC-7.B SignalR drops fall back to polling within 5s
- AC-7.C No data is lost across a push→fallback→push cycle (final state matches engine)
- AC-7.D Engine CPU usage from admin UI polling drops measurably (target ≥40% reduction on the relevant endpoints)
- AC-7.E Connection indicator visible at all times to authenticated users

#### 5.7.5 Engine dependencies

NEW: SignalR hub registration in engine. Requires engine team collaboration; coordinated branch.

---

## 6. Non-functional requirements

### 6.1 Performance

| Metric                         | Target                                          | Measurement                 |
| ------------------------------ | ----------------------------------------------- | --------------------------- |
| LCP                            | < 1.8s on every route (tightened from 2s in v1) | Web vitals → Sentry         |
| INP                            | < 200ms                                         | Web vitals                  |
| CLS                            | < 0.05                                          | Web vitals                  |
| Route navigation               | < 400ms (tightened from 500ms in v1)            | Synthetic in Playwright     |
| Table re-render (100 rows)     | < 100ms                                         | Performance.now() benchmark |
| Bundle initial (gzipped)       | < 500 KB                                        | Bundle stats CI             |
| Bundle total (gzipped)         | < 1.5 MB                                        | Bundle stats CI             |
| Per-route lazy chunk (gzipped) | < 200 KB                                        | Bundle stats CI             |

### 6.2 Accessibility

- WCAG 2.1 AA across every route
- Lighthouse a11y score ≥ 95 per route (enforced in CI)
- axe-core in Playwright suite (block on any new violation)
- Skip-to-content link, focus rings, keyboard nav for every interactive element
- Color contrast ≥ 4.5:1 for normal text, 3:1 for large text and UI components
- `aria-label` / `aria-current` / `aria-expanded` on nav and interactive controls
- Confirm dialogs `role="dialog"` + `aria-modal` + autofocus on primary action + Esc-to-close
- Form fields use `<app-form-field>` + `appFormFieldControl` (label association, aria-required, aria-invalid, aria-describedby)

### 6.3 Security

- JWT bearer token; mirrored to sessionStorage (survives refresh, not tab close); 30-min idle-timeout watcher (existing)
- All API traffic HTTPS in non-dev environments (enforced by nginx)
- CSP headers (existing nginx config); audit to whitelist SignalR + Sentry endpoints in Phase 7
- No sensitive data in URL parameters
- Strict-mode TypeScript (existing)
- RBAC: server is authoritative; UI hides controls for missing roles but never trusts itself
- Destructive actions write to audit trail with reason
- Authorization header scrubbed from Sentry breadcrumbs (existing)

### 6.4 Observability

- **Sentry** (existing): error tracking, transaction sampling 5%, breadcrumb scrubbing
- **Sentry Session Replay** (NEW): gated rollout, 5% sample, masked PII, only on error
- **Web vitals** (existing): LCP, INP, CLS, FCP, TTFB → Sentry measurements
- **Custom Sentry tags** (NEW): route, feature surface, RBAC role
- **Operator action breadcrumbs** (NEW): kill-switch toggled, role granted, training triggered, auto-tune applied, model promoted/rolled-back — all leave a Sentry breadcrumb
- **App version pill in footer** (NEW): exposes UI build SHA + engine `/health/status` version
- **Per-route Sentry transaction** (existing via Angular routing integration)

### 6.5 Browser support

- Latest 2 versions of Chrome, Firefox, Edge, Safari (existing)
- No IE
- Mobile breakpoints (existing): drawer below 768px

### 6.6 Internationalization

- English-only. `@angular/localize` references stripped from build config (decision #7).

### 6.7 PWA / Offline

- Service worker removed. `ngsw-config.json` deleted. (Decision #6: offline-first UX for an admin UI is misleading.)
- Offline banner retained (it polls engine reachability; banner appears on disconnect).

---

## 7. Design system & UX conventions

Carried forward from v1, extended:

### 7.1 Visual language

- **Apple-inspired**: rounded corners (8/12/16), generous whitespace, subdued accents, high-contrast text
- **Tokens-only**: no raw hex in component styles; all colors via `_tokens.scss` (existing)
- **Dark mode**: `ThemeService` toggle in header; SCSS tokens flip on `[data-theme="dark"]`; echarts themes (`lascodia-light` / `lascodia-dark`) switch with theme
- **Glassmorphism**: `--bg-glass`, `--blur-{sm,md,lg}` tokens; used on modals, sidebar (dark), command palette
- **Animation polish**: button press scale 0.97; modal enter 0.96→1.0 0.25s ease-out; chart-card hover lift; `--ease-{out-soft,press}` tokens
- **Wall mode**: kiosk display variant (existing); v2 verifies network resilience and big-text scaling

### 7.2 Layout shell

- Sidebar nav (collapsible; drawer below 768px)
- Header: search, command palette trigger (⌘K), theme toggle, notifications, avatar dropdown
- Breadcrumbs as `<nav aria-label="Breadcrumb"><ol>`
- Banners stack: offline → kill-switch → paper-mode → rate-limit-strip
- Footer: app version pill (NEW)

### 7.3 Interaction patterns

- **Command palette** (⌘K / Ctrl+K): fuzzy filter across every route. Extended in v2 to include actions (e.g. "Toggle kill switch", "Open CompositeML")
- **Keyboard shortcuts**: `g`-prefix two-key nav (`g d` dashboard, etc.); `?` toggles help overlay
- **Confirm dialogs**: role="dialog" + aria-modal + Esc + autofocus on primary action; required reason field for destructive actions writing to audit trail
- **Empty states / error states / loading skeletons**: shared primitives used everywhere
- **Toasts**: success / info / warn / error via NotificationService
- **Side drawer / detail panel**: standard pattern for drill-in detail without route change

### 7.4 Form conventions

- Reactive Forms; `<app-form-field>` wrapper + `appFormFieldControl` directive
- Validators from `AppValidators`
- Submit disabled while invalid
- Inline error display via `role="alert"`
- Destructive actions require reason text input

### 7.5 Data table conventions

- AG-Grid with custom `lascodia-apple` theme partials
- Cell renderers as Angular components (no `innerHTML` strings — completed in v2)
- Pagination as `<nav>` with `aria-current="page"`
- Search as `<label>`-wrapped `<input type="search">`
- Bulk selection with `#bulkActions` template slot
- State (filter / sort / page) persisted per route via `TableStateService` (existing)

---

## 8. Operational requirements

### 8.1 Build & runtime

- Angular 20 (upgraded from 19.2 in Phase 0)
- Standalone components + signals
- Bundle: Vite-backed Angular CLI
- Production build clean of warnings (existing); CI fails on any warning
- Runtime config via `public/config.json` (existing); `API_BASE_URL` env override in Docker entrypoint (existing)

### 8.2 API client

- **NEW: generated typed client** via `ng-openapi-gen` against `engine/swagger/v1/swagger.json`
- Generated client under `src/app/core/api/generated/`
- `api.types.ts` retained only for UI-specific types (computed projections, store shapes)
- CI job: regenerate client on PR; fail if generated diff isn't committed (catches engine API drift)

### 8.3 Testing

| Tier                  | Tool                                               | Target coverage / scope                                                                                                                                               |
| --------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**              | Vitest                                             | ≥ 40% line coverage on `core/` + `shared/services`                                                                                                                    |
| **Component**         | Vitest + Angular TestBed (unblocked by Angular 20) | All `shared/components/*`; ≥ 60% per component                                                                                                                        |
| **E2E**               | Playwright                                         | Backend-independent smoke (existing) + backend-fixture mode (NEW) for: kill-switch toggle, role grant/revoke, training trigger, LLM-proposal promote, auto-tune apply |
| **A11y**              | axe-core in Playwright (NEW)                       | Block PR on any new WCAG 2.1 AA violation                                                                                                                             |
| **Visual regression** | Storybook + Playwright screenshot diff (NEW)       | All `shared/components/*` stories                                                                                                                                     |

### 8.4 Storybook

- Reactivated (existing config in `.storybook/`)
- Stories for every `shared/components/*`
- `@storybook/addon-a11y` (NEW) for in-Storybook a11y checks
- CI: `npm run build-storybook`; artifact published

### 8.5 CI/CD

GitHub Actions workflow extended:

| Job                    | Purpose                                           | Gate                                |
| ---------------------- | ------------------------------------------------- | ----------------------------------- |
| `build-test`           | Vitest unit + component + lint + production build | Fail PR                             |
| `e2e`                  | Playwright smoke + backend-fixture E2E + axe      | Fail PR                             |
| `bundle-stats` (NEW)   | `source-map-explorer`; comment PR with size delta | Fail if budget exceeded             |
| `lighthouse` (NEW)     | LHCI per route with budgets                       | Fail if perf < 85 or a11y < 95      |
| `storybook` (NEW)      | Build + visual-regression diff                    | Fail on new diffs without review    |
| `docker`               | Buildx image on `main` push                       | Push to registry                    |
| `deploy-staging` (NEW) | Push image to staging environment                 | Auto on `main`                      |
| `smoke-staging` (NEW)  | Run Playwright smoke against deployed staging     | Fail blocks promotion to production |

### 8.6 Bundle budgets (enforced in CI)

| Resource                       | Warn   | Error            |
| ------------------------------ | ------ | ---------------- |
| Initial bundle                 | 2 MB   | 6 MB (existing)  |
| Component styles               | 12 KB  | 20 KB (existing) |
| **Per-route lazy chunk** (NEW) | 200 KB | 350 KB           |

### 8.7 Release process

- Semantic versioning on UI (independent of engine)
- Build SHA surfaced in footer pill
- Staging auto-deploys on `main`; production deploy is manual promotion of the staging image (no rebuild)
- Sentry release tagged with the UI build SHA + engine version captured at deploy time

### 8.8 Documentation

- README updated to reflect v2 scripts, codegen, Storybook
- This PRD (PRD_V2.md) is the authoritative spec
- UPGRADE_PLAN_V2.md is the execution plan (to be authored from this PRD)
- ADRs added when implementation choices warrant (e.g. "ADR: SignalR over SSE")

---

## 9. Decisions log

| #   | Decision            | Choice                                                                    | Rationale                                                    |
| --- | ------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| D1  | Real-time transport | **SignalR** (engine-side hub + client)                                    | Existing UI stub; .NET-native; reconnect/fallback ergonomics |
| D2  | API client          | **Generated via `ng-openapi-gen`**                                        | Stop hand-maintained DTO drift                               |
| D3  | Storybook           | **Reactivate**                                                            | Earn it back via visual regression in Phase 8                |
| D4  | Angular version     | **Upgrade to 20**                                                         | Unblocks component-test scaffolds                            |
| D5  | State pattern       | **Signal stores for hot data; services + polled-resource for cold reads** | Reduce mixing; codify in CLAUDE.md                           |
| D6  | PWA / Offline       | **Remove ngsw**                                                           | Admin UI without engine is misleading                        |
| D7  | i18n                | **English-only**                                                          | No stakeholder demand; cost outweighs benefit                |
| D8  | RBAC enforcement    | **Server authoritative; UI hides controls**                               | Defense-in-depth                                             |

---

## 10. Success metrics

Measured at end of v2 rollout (Phase 8 exit):

| Metric                                               | Target                                                     | Source                                          |
| ---------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| Engine endpoints surfaced                            | ≥ 95% of operator-relevant                                 | Manual audit against `/swagger/v1/swagger.json` |
| Operator daily-workflow tool count                   | UI only (no `psql`/SSH/Docker for golden workflows)        | Workflow audit                                  |
| Sentry error rate                                    | < 0.1% sessions                                            | Sentry dashboard                                |
| LCP p75                                              | < 1.8s                                                     | Sentry / web vitals                             |
| INP p75                                              | < 200ms                                                    | Sentry / web vitals                             |
| Lighthouse a11y                                      | ≥ 95 per route                                             | LHCI                                            |
| Lighthouse perf                                      | ≥ 85 per route                                             | LHCI                                            |
| Initial bundle gzipped                               | < 500 KB                                                   | Bundle stats                                    |
| Test coverage (core + shared)                        | ≥ 40% lines                                                | Vitest coverage report                          |
| Component test coverage                              | ≥ 30% on shared/components/\*                              | Vitest coverage                                 |
| Time to grant a new operator role                    | < 1 minute                                                 | UX timing                                       |
| Time to diagnose "no signals being generated" via UI | < 5 minutes (target case: CompositeML trainer suppression) | Scenario S3 audit                               |
| Engine polling load reduction (post Phase 7)         | ≥ 40% on hot-data endpoints                                | Engine metrics                                  |

---

## 11. Dependencies

### 11.1 Internal dependencies

- **Engine team availability** for Phase 7 (SignalR hub). Coordinated branch; sequence Phase 7 last so feature waves don't block on it.
- **Angular 20 upgrade** (Phase 0) is the prerequisite for component tests in Phase 8.
- **OpenAPI codegen** (Phase 0) underpins type safety in every feature wave.

### 11.2 External dependencies

- `ng-openapi-gen` or equivalent codegen library
- `@storybook/addon-a11y` for in-Storybook a11y checks
- `@lhci/cli` for Lighthouse CI
- `source-map-explorer` or `bundle-stats` for bundle tracking
- Continued: Sentry, web-vitals, AG-Grid, echarts, Playwright

### 11.3 Engine prerequisites by feature surface

| Surface               | Engine endpoint or work needed                                 | Status                           |
| --------------------- | -------------------------------------------------------------- | -------------------------------- |
| §5.1 CompositeML      | All 13 `/composite-ml/*` endpoints                             | **Done**                         |
| §5.2 ML Lifecycle     | `/ml-model/{id}/lifecycle`, drift, overfit, symbolic           | **Done**                         |
| §5.3 Strategy v2      | LLM proposals, variants, capacity, templates, schema           | **Done**                         |
| §5.4 Auto-tune        | `/auto-tune/*`                                                 | **Done**                         |
| §5.5 EA control       | `/ea/symbol-specs/refresh`, `/ea/commands/update-config`, etc. | **Done**                         |
| §5.6 RBAC             | `/admin/operator-roles/*`                                      | **Done**                         |
| §5.6 System logs      | `/system/logs`                                                 | **Done**                         |
| §5.6 Drawdown history | `/drawdown-recovery/history`                                   | **Done**                         |
| §5.7 SignalR hub      | NEW engine work                                                | **Not started** — Phase 7 prereq |

---

## 12. Risks

| #   | Risk                                                                    | Likelihood | Impact | Mitigation                                                                                |
| --- | ----------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------- |
| R1  | Engine endpoints change shape mid-cycle                                 | M          | M      | Codegen catches shape changes at compile time; engine-stable windows for Phase 7          |
| R2  | Angular 20 upgrade breaks something material                            | M          | M      | Branch + green CI before merge; revert plan; landed in Phase 0 to surface issues early    |
| R3  | SignalR hub work blocks on engine team                                  | H          | M      | Sequence Phase 7 last; Phases 1–6 are independent                                         |
| R4  | CompositeML console too dense for non-experts                           | M          | L      | Every panel has inline help linking to relevant ADR; iterate on operator feedback         |
| R5  | RBAC visibility gates miss an edge case                                 | M          | L      | Server is authoritative; UI gating is UX-only                                             |
| R6  | Test infrastructure (component tests, axe-core, LHCI) eats Phase 0 time | M          | M      | Time-box Phase 0 to 1 week; defer items not blocking other phases                         |
| R7  | Storybook reactivation creates "dead stories" debt                      | L          | L      | Tie stories to visual regression in CI; abandoned stories caught by failing visual diff   |
| R8  | Operator role escalation (operator self-grants admin)                   | L          | H      | Server enforces; grant endpoint requires existing admin; audit log alerts on grant events |
| R9  | Real-time push regression (lost messages) under load                    | M          | M      | Fallback to polling on connection drop; on reconnect, fetch full state from REST          |
| R10 | Bundle budgets too tight; legitimate features blocked                   | L          | L      | Tune budgets at end of Phase 0 from measured baseline                                     |

---

## 13. Open questions

1. **Q1** — Should the "Effective Roles" display in the avatar dropdown also show _what_ each role permits, or just role names? (Affects UX of role discoverability.) **Default: role names only; permission descriptions via Storybook docs.**

2. **Q2** — Auto-tune Apply: should it require _two_ operator confirmations for proposals outside the auto-apply set? (Defense-in-depth for irreversible knobs.) **Default: single confirm with required reason; revisit if a regression occurs.**

3. **Q3** — Strategy Templates: should "Apply to N symbols" create N strategies in Paused state or in Active state? **Default: Paused, requires explicit activation.**

4. **Q4** — Sentry Session Replay scope: gate to errors only, or sample 5% of all sessions? **Default: errors only, 5% sample to start; widen if budget allows.**

5. **Q5** — System Logs: max retained lines in live-tail mode. **Default: 5000 lines; oldest evicted FIFO.**

6. **Q6** — Order-Book live view: depth levels to render. **Default: 5 levels each side; configurable to 10.**

7. **Q7** — Wall mode: should v2 add auto-rotate-dashboards? **Default: defer; wait for a clear request.**

8. **Q8** — Phase 7 SignalR: should engine reuse existing JWT for auth, or issue a separate hub token? **Default: reuse JWT; align with engine team in Phase 7 kickoff.**

---

## 14. Out of scope

| #      | Item                                   | Reason                                      |
| ------ | -------------------------------------- | ------------------------------------------- |
| OOS-1  | Mobile-native apps                     | PRD v1 non-goal; carried                    |
| OOS-2  | Multi-tenancy / customer-facing portal | This is admin/operator only                 |
| OOS-3  | TradingView-class charting             | Defer to embeds                             |
| OOS-4  | i18n / localization                    | Decision D7                                 |
| OOS-5  | Offline-first UX                       | Decision D6                                 |
| OOS-6  | ML SHAP / explainability UI            | Engine work; tracked separately             |
| OOS-7  | MFA / SSO                              | Engine work; tracked separately             |
| OOS-8  | WebSocket order-book streaming         | EA batch POSTs; SignalR fan-out only        |
| OOS-9  | Public API for third-party consumers   | Internal admin console only                 |
| OOS-10 | Marketplace for strategy templates     | Internal sharing only via templates feature |
| OOS-11 | Replacing v1 surfaces                  | v2 extends; v1 features remain              |

---

## 15. Glossary

| Term                        | Definition                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **CompositeML**             | Engine's composite ML policy framework — layered policies trained by multiple architectures with auto-arbitration                |
| **MCC**                     | Model Confidence Calibration — engine-persisted or UI-estimated score used to weight ML predictions                              |
| **EA**                      | Expert Advisor — MT4/MT5 broker-side adapter; sole bridge between engine and broker                                              |
| **DSL**                     | Domain-specific language for RuleBased / LlmProposal strategy expressions                                                        |
| **SPRT**                    | Sequential Probability Ratio Test — used by Shadow Arena for champion-challenger promotion                                       |
| **Drift**                   | Distribution change in input features or model performance; detected by Adwin, CUSUM, CovariateShift, MultiScale, DriftAgreement |
| **Layer**                   | A subsystem in the CompositeML pipeline (e.g. EntryGate, SignalRanker)                                                           |
| **Trainer**                 | An ML training procedure mapped onto a Layer (e.g. SpA for self-paced averaging)                                                 |
| **Policy snapshot**         | An immutable snapshot of CompositeML knob values; activations form a lineage chain                                               |
| **Catalogue drift**         | Decay or change in the registered catalogue entries for a layer-key over time                                                    |
| **Gate cutover**            | Per-layer switch between "ledger as source of truth" and "legacy idiom"                                                          |
| **Cold start**              | Bootstrap behavior for a layer that hasn't accumulated enough data; uses donor selection                                         |
| **Wall mode**               | Kiosk-style display variant for big-screen monitoring                                                                            |
| **Symbolic feature**        | A mined feature expression from the genetic-programming pipeline (V8)                                                            |
| **LLM proposal**            | A strategy generated by the LLM proposal worker, awaiting operator promotion                                                     |
| **Variant**                 | An A/B shadow test variant attached to a base strategy                                                                           |
| **Auto-tune**               | The subsystem that proposes config-knob changes based on observed behavior                                                       |
| **RBAC**                    | Role-Based Access Control                                                                                                        |
| **Push / Pull**             | Real-time transport mode: push = SignalR; pull = polling                                                                         |
| **PromotionReviewSnapshot** | Audit record of a promotion review action                                                                                        |
| **ReflectionEntry**         | Operator-authored note attached to a decision in the audit trail                                                                 |
| **LifecycleEventRationale** | Detailed reason text for a lifecycle transition (Activation, Supersession, DegradationRetirement)                                |
| **LlmInvocation**           | Audit record of an LLM call (proposal generation, narrative augmentation, etc.)                                                  |

---

## 16. Appendix: feature surface ↔ engine endpoint mapping

(See §11.3 for delivery status. This appendix lists every endpoint touched by v2.)

### §5.1 CompositeML

- GET `/composite-ml/active-policies`
- GET `/composite-ml/policy-snapshots/diff`
- GET `/composite-ml/policy-lineage/{id}`
- GET `/composite-ml/layer-health`
- GET `/composite-ml/layer-skill-snapshots`
- POST `/composite-ml/layer-skill-manual-override`
- GET `/composite-ml/trainer-skill-snapshots`
- POST `/composite-ml/trainer-skill-manual-override`
- GET `/composite-ml/catalogue-drift/summary`
- GET `/composite-ml/catalogue-drift/history`
- GET `/composite-ml/cold-start-report`
- GET `/composite-ml/donor-selection`
- GET `/composite-ml/options-health`
- GET `/composite-ml/gate-cutover/status`
- POST `/composite-ml/gate-cutover`

### §5.2 ML Lifecycle Depth v2

- GET `/ml-model/{id}/lifecycle`
- GET `/ml-model/{id}/feature-importance`
- GET `/ml-model/overfit-watchlist`
- POST `/ml-model/drift-report`
- GET `/ml-model/symbolic-features`
- POST `/ml-model/symbolic-features/{id}/promote`
- POST `/ml-model/symbolic-features/{id}/retire`
- GET `/ml-model/symbolic-features/{id}/decay-history`
- GET `/ml-model/v6-orderbook-feature-utilization`
- GET `/ml-model/training/available-architectures`

### §5.3 Strategy Discovery & Lifecycle v2

- GET `/strategy/llm-proposals`
- POST `/strategy/llm-proposals/{id}/promote`
- GET `/strategy/{id}/variants`
- POST `/strategy/variants/{variantId}/promote`
- GET `/strategy/{id}/capacity-profile`
- GET `/strategy/allocation-weights`
- POST `/strategy/{id}/rejection-distribution`
- GET `/strategy/rejection-summary`
- GET `/strategy/templates`
- POST `/strategy/templates`
- POST `/strategy/templates/apply`
- DELETE `/strategy/templates/{id}` (if exposed)
- GET `/strategy/parameter-schema/{strategyType}`
- Reads from `LlmInvocation`, `PromotionReviewSnapshot`, `ReflectionEntry` (via dedicated endpoints if added; otherwise via existing list endpoints with filters)

### §5.4 Autonomous Mutation Controls

- GET `/auto-tune/proposals`
- POST `/auto-tune/proposals/{id}/apply`
- POST `/auto-tune/proposals/{id}/reject`
- GET `/auto-tune/auto-apply-configs`
- GET `/auto-tune/auto-apply-configs/{key}`
- PUT `/auto-tune/auto-apply-configs/{key}`
- DELETE `/auto-tune/auto-apply-configs/{key}`

### §5.5 EA Live Control Plane

- GET `/ea/instances`
- GET `/ea/instances/{id}` (may need engine-side addition)
- PUT `/ea/symbol-specs/refresh`
- POST `/ea/commands/update-config`
- POST `/ea/signal-feedback` (read side)
- GET `/market-data/order-book/latest/{symbol}`
- GET `/market-data/order-book/recent`
- GET `/market-data/candle/watermarks`
- GET `/market-data/candle/coverage`
- POST `/ea/positions/delta` (read side)

### §5.6 RBAC v1 + System Diagnostics

- GET `/admin/operator-roles`
- POST `/admin/operator-roles/grant`
- POST `/admin/operator-roles/revoke`
- GET `/auth/me` (or equivalent)
- GET `/system/logs`
- GET `/health/worker-override-knobs`
- GET `/health/defaults-calibration`
- POST `/drawdown-recovery/history`

### §5.7 Real-time Push Channel

- NEW `/realtime/hub` (SignalR)
  - Channel: `positions.pnl`
  - Channel: `prices`
  - Channel: `signals.pending`
  - Channel: `signals.approved`
  - Channel: `kill-switch`
  - Channel: `paper-mode`
  - Channel: `rate-limit`
  - Channel: `system-logs`

---

## Changelog

| Version   | Date       | Notes                                                                                     |
| --------- | ---------- | ----------------------------------------------------------------------------------------- |
| 2.0-draft | 2026-05-10 | Initial v2 PRD; companion to v1 PRD; informed by 2026-04-24 plan + post-April commit wave |

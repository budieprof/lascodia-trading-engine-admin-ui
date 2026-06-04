# Spot Sweep — Autonomous Spot-Analysis Loop

> Status: draft / in-progress. UI cockpit (Phase 1) being scaffolded in this
> repo against the API contract in §4. Engine pieces (worker, config table,
> endpoints) live in the engine repo and are specced here, not yet built.

## 1. Concept

An engine background worker walks a persisted list of pairs, **one analysis in
flight at a time**, skipping any pair that already has exposure, runs the
existing LLM analyze pipeline with signal generation, and — when the result
clears the gate, a confidence threshold, and risk caps — **auto-approves the
signal and places the order**. The UI is the cockpit: configure, enable,
monitor, stop.

Short name: **Sweep**. Engine worker: `SpotSweepWorker`. UI feature:
`spot-sweep`.

Decisions locked with the product owner:

- **Engine-owned** sweep loop (not a browser loop).
- **Engine-persisted** sweep-pairs config.
- **Full automation**: continue past signal creation to auto-approve + place
  order.

## 2. Architecture split

| Layer                              | Owner        | Responsibility                                                |
| ---------------------------------- | ------------ | ------------------------------------------------------------- |
| `SpotSweepWorker` (hosted service) | Engine       | the loop, eligibility, analyze, auto-approve→order, telemetry |
| `SpotSweep` config (persisted)     | Engine       | enabled, pairs, pacing, thresholds, caps, scope, mode         |
| `/market-data/spot-sweep/*` API    | Engine       | read/write config, runtime status                             |
| Cockpit page + service             | This UI repo | control surface + live monitor                                |
| History                            | reuse        | existing Spot Analysis report, filtered to sweep source       |

**Why engine-owned:** a single authoritative loop (no per-tab duplication),
survives no UI being open, and the eligibility + dedupe checks run atomically at
order time where they are race-safe.

## 3. Worker algorithm (engine)

Single-threaded loop, one analysis in flight:

1. **Guards** → set `idleReason` and wait `intervalSeconds` if any fail: not
   `enabled`; kill switch active; a daily cap hit; an analysis already running.
2. **Build eligible set** from `config.pairs`, excluding (across the scoped
   active accounts) any symbol with: an **Open position**, a **Pending/Working
   order**, a **Pending TradeSignal**, or — if `requireActiveEaCoverage` — no
   active EA covering it.
3. If empty → `idleReason = "no coverage gaps"`, wait, retry.
4. **Pick next** by round-robin cursor.
5. `analyzeMarket(symbol, tf, generateSignals=true, barPosition)` — existing
   pipeline; the gate runs as today.
6. If a signal is created and `autoApprove && confidence ≥ minConfidence &&
caps OK && mode permits`: **re-check exclusion** (state may have changed
   during LLM latency) → approve → place order via the existing approve/order
   path. Otherwise leave it **Pending** for manual review (graceful degrade —
   low-confidence never auto-trades).
7. Record telemetry + cost, advance cursor, wait `intervalSeconds`, loop.

**Idempotency:** tag every created signal/order with a `sweepRunId + symbol` so
a restart mid-cycle cannot double-submit.

## 4. API contract (engine to implement, UI consumes)

```
GET  /market-data/spot-sweep/config   → SpotSweepConfig
PUT  /market-data/spot-sweep/config   ← SpotSweepConfig   (carries full pairs array + enabled)
GET  /market-data/spot-sweep/status   → SpotSweepStatus   (poll ~5s, or realtime event)
```

DTO shapes are mirrored in `src/app/features/spot-sweep/spot-sweep.types.ts`
(move to the generated `api.types.ts` via `npm run codegen:api` once the engine
ships the endpoints).

`SpotSweepConfig`

- `enabled`, `mode: 'Paper' | 'Live'`
- `pairs: { symbol, timeframe }[]`, `barPosition: 'closed'|'mid_25'|'mid_50'|'mid_75'`
- `intervalSeconds` (inter-analysis pacing)
- `accountScope: number[] | 'AllActive'`
- `autoApprove`, `minConfidence` (0–1)
- exclusion toggles: `excludeOpenPosition`, `excludePendingOrder`,
  `excludePendingSignal`, `requireActiveEaCoverage`
- caps: `maxConcurrentSweepPositions`, `maxNewOrdersPerDay`,
  `maxDailyLlmCostUsd`, `maxRiskPerTrade`
- `respectKillSwitch` (default true)

`SpotSweepStatus` (runtime)

- `running`, `phase: 'Idle'|'Analyzing'|'Cooldown'`, `idleReason: string|null`
- `currentSymbol`, `startedAt`, `nextEligibleSymbol`
- `lastResult: { symbol, outcome, signalId?, orderId?, autoApproved, costUsd, at }`
- `today: { analyses, signalsCreated, ordersPlaced, autoApproved, manualPending, gateRejected, costUsd }`
- `killSwitchActive`, `eligibleCount`, `excludedCount`

Optional realtime: `spotSweep.progress` event carrying `SpotSweepStatus`.

## 5. Safety model (non-negotiable for auto-order)

- **Default Paper.** Switching to `Live` requires an explicit confirmation in
  the UI.
- **Kill-switch integration**: existing global/per-symbol kill switches halt the
  sweep (per-symbol ones drop that symbol from eligibility). Reuse
  `KillSwitchBanner`.
- **Hard caps** stop the loop with a surfaced `idleReason` (daily orders, daily
  LLM cost, concurrent positions, per-trade risk).
- **Confidence gate**: below `minConfidence` (or failing the existing gate) →
  signal stays Pending, never auto-traded.
- **Full provenance**: every signal/order keeps `LlmInvocationId + sweepRunId`;
  visible in the Spot Analysis report and order audit.

## 6. UI work (this repo)

```
src/app/features/spot-sweep/
  spot-sweep.routes.ts
  spot-sweep.types.ts
  pages/spot-sweep-page/spot-sweep-page.component.ts        # cockpit
src/app/core/services/spot-sweep.service.ts                 # GET/PUT config, GET status
```

- **Status polling** via `createPolledResource(getStatus, { intervalMs: 5000, active: tabFocused })`.
- **Reuse**: `AccountScopeService` for scope; `KillSwitchBanner`; the Spot
  Analysis report for history; `CurrencyPairsService` / watchlist to seed pairs.
- **Routing/nav**: lazy route `/spot-sweep`, sidebar entry under **LLM**.
- **Types**: regenerate via `npm run codegen:api` once the engine endpoints
  land.
- The cockpit is driven by an in-memory mock in `SpotSweepService`
  (`USE_MOCK = true`) until the engine endpoints exist; flip to false to go
  live against the real API.

## 7. Phased delivery (de-risks the automation)

- **Phase 1 — Config + monitor, no trading.** Engine: config persistence +
  status + worker that only analyzes and creates **Pending** signals, paper
  scope. UI: full cockpit (enable, pairs, pacing, live status). ← _UI scaffold
  in progress._
- **Phase 2 — Auto-approve → order on paper.** Add `autoApprove` +
  `minConfidence` + caps; place orders on **paper accounts only**.
- **Phase 3 — Live.** Unlock `Live` behind confirmation + kill-switch + caps +
  alerts.
- **Phase 4 — Polish.** Priority ordering (regime/volatility), realtime status
  push, cost/throughput dashboards.

## 8. Open contract questions (engine + UI to align)

1. Do risk caps reuse the existing **RiskProfile**, or are they sweep-specific?
2. How does `accountScope` pass through `analyzeMarket` for live ordering (which
   account executes when several are in scope)?
3. Realtime event name/shape, or poll-only for v1?

# Spot Sweep — Engine Implementation Hand-off (Phase 1 + 2)

> Companion to `SPOT_SWEEP_PLAN.md`. This is the implementation-level spec for
> the **engine repo** work: the persisted config, the three endpoints, and the
> `SpotSweepWorker`. The admin-UI cockpit already speaks this contract (mock
> until these ship). Move this doc to the engine repo alongside
> `PHASE_2_PLAN.md` when picked up.

## A. Config persistence

A single-row (or singleton-keyed) config the worker reads each tick and the
endpoints read/write. Suggested table `spot_sweep_config`:

| column                           | type      | notes                                      |
| -------------------------------- | --------- | ------------------------------------------ |
| `id`                             | int PK    | singleton (always 1)                       |
| `enabled`                        | bool      | master switch                              |
| `mode`                           | text      | `Paper` \| `Live`                          |
| `pairs`                          | jsonb     | `[{ symbol, timeframe }]`                  |
| `bar_position`                   | text      | `closed`\|`mid_25`\|`mid_50`\|`mid_75`     |
| `interval_seconds`               | int       | inter-analysis pacing                      |
| `account_scope`                  | jsonb     | `number[]` of accountIds, or `"AllActive"` |
| `auto_approve`                   | bool      |                                            |
| `min_confidence`                 | numeric   | 0..1                                       |
| `exclude_open_position`          | bool      |                                            |
| `exclude_pending_order`          | bool      |                                            |
| `exclude_pending_signal`         | bool      |                                            |
| `require_active_ea_coverage`     | bool      |                                            |
| `max_concurrent_sweep_positions` | int       |                                            |
| `max_new_orders_per_day`         | int       |                                            |
| `max_daily_llm_cost_usd`         | numeric   |                                            |
| `max_risk_per_trade`             | numeric   | lots (or map to RiskProfile — see Q1)      |
| `respect_kill_switch`            | bool      |                                            |
| `updated_at` / `updated_by`      | ts / text | audit                                      |

Daily counters (orders placed, LLM cost) are derived from existing tables
filtered by `sweepRunId`/source + today's date — no extra counter columns
needed.

## B. Endpoints

All under the existing `/market-data` controller, envelope-wrapped like the
rest (`ResponseData<T>`).

```
GET  /market-data/spot-sweep/config        → SpotSweepConfig
PUT  /market-data/spot-sweep/config        ← SpotSweepConfig  → SpotSweepConfig (echo saved)
GET  /market-data/spot-sweep/status        → SpotSweepStatus
GET  /market-data/spot-sweep/history?limit  → SweepHistoryItem[]
```

`GET history` returns recent sweep cycles newest-first — back it with the Spot
Analysis report rows filtered to the sweep source/`sweepRunId` (map each to a
`SweepHistoryItem`). `SweepHistoryItem` shape is in the UI types file.

- `PUT` carries the **whole** config (UI sends the full object incl. `pairs`
  and `enabled`). Validate: pairs symbols exist in `currency_pair` & are
  active; `0 ≤ minConfidence ≤ 1`; `intervalSeconds ≥ 5`; if `mode=Live`,
  require caller policy ≥ operator.
- `GET status` is read from the worker's in-memory snapshot (below). If the
  worker isn't running the process, return `running:false, phase:Idle,
idleReason:"worker offline"`.

DTO field names are authoritative in
`admin-ui/src/app/features/spot-sweep/spot-sweep.types.ts`.

## C. Worker loop (`SpotSweepWorker`, hosted service)

Single-threaded, one analysis in flight. Holds a mutable `StatusSnapshot`
served by `GET status`.

```
loop forever:
  cfg = loadConfig()
  snapshot.today = deriveTodayCounters(sweepRunId, today)   // from signals/orders/llm tables

  // ---- guards ----
  if (!cfg.enabled)                       => park("Sweep disabled")
  if (cfg.respectKillSwitch && killSwitch.anyActive())
                                          => park("Kill switch active")
  if (cfg.autoApprove && capsHit(cfg, snapshot.today))
                                          => park(capReason)            // see E
  // (only one analysis in flight by construction — loop is sequential)

  // ---- eligibility ----
  scopeAccountIds = resolveScope(cfg.accountScope)          // AllActive => active accounts
  eligible = cfg.pairs.filter(p => isEligible(p.symbol, scopeAccountIds, cfg))
  snapshot.eligibleCount = eligible.length
  snapshot.excludedCount = cfg.pairs.length - eligible.length
  if (eligible.isEmpty)                    => park("No coverage gaps"); sleep(interval); continue

  // ---- pick + analyse ----
  pair = roundRobinNext(eligible, cursor)
  snapshot.phase = Analyzing; snapshot.currentSymbol = pair.symbol; snapshot.startedAt = now
  result = analyzeMarket(pair.symbol, pair.timeframe,
                         generateSignals=true, barPosition=cfg.barPosition,
                         accountScope=scopeAccountIds, sweepRunId=runId)
  // gate runs inside analyzeMarket exactly as today

  // ---- auto-approve -> order ----
  if (result.signal != null):
     sig = result.signal
     if (cfg.autoApprove
         && sig.confidence >= cfg.minConfidence
         && passesGate(result)
         && !capsHit(cfg, snapshot.today)
         && reCheckEligible(sig.symbol, scopeAccountIds, cfg)):   // re-check after LLM latency
        approveSignal(sig.id)                 // existing PUT /trade-signal/{id}/approve path
        order = placeOrderFromSignal(sig, mode=cfg.mode, account=pickAccount(scopeAccountIds))
        tag(order, sweepRunId=runId)
     else:
        // leave Pending for manual review (graceful degrade)

  recordLastResult(snapshot, pair, result)
  advance(cursor)
  snapshot.phase = Cooldown
  sleep(cfg.intervalSeconds)
```

### `isEligible(symbol, scopeAccountIds, cfg)`

Skip the symbol if **any** enabled rule matches, evaluated across
`scopeAccountIds`:

- `excludeOpenPosition` && exists Position{symbol, status=Open, accountId ∈ scope}
- `excludePendingOrder` && exists Order{symbol, status ∈ (Pending,Working), accountId ∈ scope}
- `excludePendingSignal` && exists TradeSignal{symbol, status=Pending}
- `requireActiveEaCoverage` && **no** active EA in scope whose `symbols` contains it

These are the same predicates the UI describes; enforce them **here** (not in
the UI) so they're race-safe.

## D. Idempotency & provenance

- Generate a `sweepRunId` (per worker process start, or per day). Tag every
  created `TradeSignal` and `Order` with it (plus the existing
  `LlmInvocationId`). Reuse `TradeSignalSource.SpotAnalysis`; add a
  `sweepRunId` column or reuse a metadata/json column.
- The **re-check** (`reCheckEligible`) right before `placeOrderFromSignal`
  closes the window where state changed during LLM latency.
- On worker restart mid-cycle, the eligibility check naturally prevents
  double-submit (a just-created Pending signal/order excludes the symbol).

## E. Caps enforcement (`capsHit`)

Park the loop (set `idleReason`) — do **not** silently skip — when:

- `ordersPlacedToday(sweepRunId) ≥ maxNewOrdersPerDay`
- `llmCostToday(sweepRunId) ≥ maxDailyLlmCostUsd`
- `openSweepPositions(sweepRunId) ≥ maxConcurrentSweepPositions`
- a single recommendation's risk (lots) > `maxRiskPerTrade` → skip _that order_,
  not the whole loop.

## F. Status snapshot → `SpotSweepStatus`

Maintain in memory, updated each loop step; `GET status` serializes it.
`today.*` counters are re-derived from the DB each tick (cheap, indexed by
date + sweepRunId) so they survive worker restarts.

## G. Phasing for the engine

- **Phase 1**: A + B + C **without** the auto-approve→order block (signals stay
  Pending). Lets the UI cockpit drive real config/status against paper scope.
- **Phase 2**: enable the auto-approve→order block, **paper accounts only**
  (`mode=Paper` places paper orders via the existing paper path).
- **Phase 3**: allow `mode=Live`; gate behind operator policy + the caps + kill
  switch already wired.

## H. Open questions (carried from the plan)

1. `maxRiskPerTrade`: bespoke lots cap, or resolve through the account's
   `RiskProfile`?
2. `pickAccount(scopeAccountIds)` when several accounts are in scope for a live
   order — first active? per-pair pinning? round-robin?
3. Realtime `spotSweep.progress` event, or UI polls `GET status` (currently 5s)?

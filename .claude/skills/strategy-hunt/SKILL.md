---
name: strategy-hunt
description: Generate a small batch of diverse trading-strategy candidates against the Lascodia engine, queue manual optimization runs, monitor to terminal state, and report which ones beat their baseline. Designed to be paired with /loop for continuous strategy discovery (`/loop /strategy-hunt`).
---

# /strategy-hunt — generate & optimize a batch of candidate strategies

You are running one batch of strategy generation against the Lascodia trading engine.

The engine runs locally at `http://localhost:5081`, the Postgres DB is in docker container `lascodia-trading-engine-postgres-1` (database `LascodiaTradingEngineDb`, user `postgres`). Both must be up before the skill can work — abort early with a clear message if either is unreachable.

## Input

Parse the user's args (whitespace-delimited tokens after the skill name):

- `N` (an integer 1–6, default `3`) — batch size
- `focus=<symbol>` (optional) — bias selection toward this symbol (e.g. `focus=EURUSD`)
- `type=<StrategyType>` (optional) — bias selection toward this StrategyType
- Anything else: treat as free-form intent ("aggressive", "scalping", etc.) and use as a soft hint when picking.

If args are empty, default to N=3, no focus.

## What "good" means

A candidate is a **win** when its optimization run finishes with `Status='Completed'` AND `BestHealthScore > BaselineHealthScore`. Anything else (Failed, search-exhausted, BestHealthScore ≤ Baseline) is a non-win — but a Completed run with no improvement is still useful signal.

## Workflow

### 1. Preflight

Run these checks in parallel — abort the skill with a short message if any fail:

```bash
curl -sf -o /dev/null -w "engine: %{http_code}\n" http://localhost:5081/health
docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -tAc "SELECT 1;"
```

Get a bearer token (the engine has a dev-only token endpoint that's `[AllowAnonymous]` when ASPNETCORE_ENVIRONMENT=Development):

```bash
TOKEN=$(curl -s -X POST http://localhost:5081/api/v1/lascodia-trading-engine/auth/token \
  -H "Content-Type: application/json" \
  -d '{"userId":"strategy-hunt","firstName":"Hunt","lastName":"Skill","email":"hunt@dev.local","roles":["Operator","Analyst"]}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
```

Store `TOKEN` for the rest of the batch.

### 2. Capacity check

Don't oversaturate the optimization worker. Read `MaxConcurrentRuns` from config and current in-flight count:

```sql
-- max concurrent
SELECT "Value" FROM "OptimizationConfig" WHERE "Key" = 'MaxConcurrentRuns';
-- or fall back to the default if the row is absent (engine default is typically 2)

-- currently in flight
SELECT COUNT(*) FROM "OptimizationRun"
WHERE "Status" IN ('Queued','Running','Claimed') AND NOT "IsDeleted";
```

If `inFlight + N > MaxConcurrentRuns`, reduce `N` to fit. If no headroom at all (`inFlight ≥ MaxConcurrentRuns`), skip this batch — print "Queue saturated, skipping batch" and exit with a non-error completion so /loop comes back later.

### 3. Survey what already exists

```sql
-- live strategies — avoid creating duplicate (Symbol, Timeframe, StrategyType)
SELECT "Symbol", "Timeframe", "StrategyType", COUNT(*) AS n
FROM "Strategy"
WHERE NOT "IsDeleted" AND "LifecycleStage" NOT IN ('Pruned','Decommissioned')
GROUP BY "Symbol", "Timeframe", "StrategyType"
ORDER BY n DESC;

-- past wins — bias future picks toward these combos
SELECT s."Symbol", s."Timeframe", s."StrategyType",
       COUNT(*) FILTER (WHERE r."Status" = 'Completed' AND r."BestHealthScore" > r."BaselineHealthScore") AS wins,
       COUNT(*) FILTER (WHERE r."Status" = 'Failed') AS losses
FROM "OptimizationRun" r JOIN "Strategy" s ON s."Id" = r."StrategyId"
WHERE NOT r."IsDeleted" AND r."CreatedAt" > NOW() - INTERVAL '30 days'
GROUP BY s."Symbol", s."Timeframe", s."StrategyType"
ORDER BY wins DESC, losses ASC;
```

Also load any `strategy-hunt` memory entries for prior insights (under `~/.claude/projects/...lascodia-trading-engine-admin-ui/memory/`) — they may name combos that historically failed validation.

### 4. Plan the batch

Pick `N` candidates with these constraints:

- **Diversity**: at least 2 distinct `StrategyType` values; at least 2 distinct symbols (when N ≥ 2).
- **No duplication**: skip combos already live (from step 3).
- **Bias**: weight toward combos with prior wins; deprioritize combos with repeated validation failures.
- **Honor `focus=` / `type=`** if the user passed them, but don't violate the diversity rule unless N=1.

Symbol pool (forex majors/minors): `EURUSD`, `GBPUSD`, `USDJPY`, `AUDUSD`, `USDCHF`, `NZDUSD`, `USDCAD`, `EURGBP`, `EURJPY`, `GBPJPY`. Timeframes: `M15`, `H1`, `H4` (avoid `M1`/`M5` — too noisy for the validation gates; avoid `D1` — too few candles for stats).

### 5. Author parameters per StrategyType

Stay within these ranges; they reflect what the engine's grids and evaluators actually understand. **Param-name accuracy matters** — a wrong field is silently dropped, which we already burned on once.

| StrategyType             | ParametersJson template                                                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MovingAverageCrossover` | `{"FastPeriod":<5–25>,"SlowPeriod":<2x–4x fast, max 100>,"MaType":"<Ema\|Sma>","AtrPeriod":<10–20>,"StopLossAtrMultiplier":<1.5–2.5>,"TakeProfitAtrMultiplier":<2.5–4.0>}`                                                                                                          |
| `BollingerBandReversion` | `{"Period":<15–40>,"StdDevMult":<1.8–2.8>,"AtrPeriod":<10–20>,"StopLossAtrMultiplier":<1.0–1.8>,"TakeProfitAtrMultiplier":<1.8–2.8>}` ⚠ field is `StdDevMult` (the evaluator now also accepts `StdDevMultiple`/`StdDevMultiplier` aliases, but the canonical name is `StdDevMult`). |
| `RSIReversion`           | `{"Period":<10–18>,"Oversold":<20–30>,"Overbought":<70–80>,"AtrPeriod":<10–20>,"StopLossAtrMultiplier":<1.5–2.5>,"TakeProfitAtrMultiplier":<2.0–3.5>}`                                                                                                                              |
| `MACDDivergence`         | `{"FastPeriod":<8–14>,"SlowPeriod":<20–32>,"SignalPeriod":<7–11>,"AtrPeriod":<10–20>,"StopLossAtrMultiplier":<1.5–2.5>,"TakeProfitAtrMultiplier":<2.0–3.5>}`                                                                                                                        |
| `VwapReversion`          | `{"BandStdDev":<1.5–2.5>,"AtrPeriod":<10–20>,"StopLossAtrMultiplier":<1.0–2.0>,"TakeProfitAtrMultiplier":<1.5–3.0>}`                                                                                                                                                                |
| `BreakoutScalper`        | `{"LookbackBars":<10–30>,"AtrPeriod":<10–20>,"StopLossAtrMultiplier":<1.0–2.0>,"TakeProfitAtrMultiplier":<1.5–3.0>}`                                                                                                                                                                |
| `MomentumTrend`          | `{"MomentumPeriod":<10–20>,"AtrPeriod":<10–20>,"StopLossAtrMultiplier":<1.5–2.5>,"TakeProfitAtrMultiplier":<2.0–4.0>}`                                                                                                                                                              |
| `RuleBased`              | full DSL — see step 5b below                                                                                                                                                                                                                                                        |

**5b. RuleBased DSL templates** (when picking RuleBased, pick ONE of these rule patterns and slot in the symbol/timeframe/direction; vary indicator periods within the bracketed ranges):

```jsonc
// RSI fade — sell into overbought
{ "Op":"And", "Children":[
  { "Leaf":{"Type":"IndicatorThreshold","indicatorThreshold":{"indicator":"Rsi","period":<10–18>,"operator":"GreaterThan","value":<68–78>}} },
  { "Leaf":{"Type":"IndicatorThreshold","indicatorThreshold":{"indicator":"Adx","period":14,"operator":"LessThan","value":25}} }
]}
// (mirror for Buy: Rsi LessThan 22–32 + Adx<25)

// EMA pullback in trend — buy
{ "Op":"And", "Children":[
  { "Leaf":{"Type":"PriceVsMa","priceVsMa":{"maKind":"Ema","period":50,"operator":"GreaterThan"}} },
  { "Leaf":{"Type":"IndicatorThreshold","indicatorThreshold":{"indicator":"Rsi","period":14,"operator":"LessThan","value":<40–48>}} }
]}

// Bollinger squeeze breakout — direction follows recent close vs upper/lower
{ "Op":"And", "Children":[
  { "Leaf":{"Type":"IndicatorThreshold","indicatorThreshold":{"indicator":"BollingerBandWidth","period":20,"operator":"LessThan","value":<0.005–0.012>}} },
  { "Leaf":{"Type":"IndicatorThreshold","indicatorThreshold":{"indicator":"Adx","period":14,"operator":"GreaterThan","value":20}} }
]}

// MACD trend confirm
{ "Op":"And", "Children":[
  { "Leaf":{"Type":"IndicatorComparison","indicatorComparison":{"left":{"indicator":"Macd","period":12},"operator":"GreaterThan","right":{"indicator":"MacdSignal","period":9}}} },
  { "Leaf":{"Type":"IndicatorThreshold","indicatorThreshold":{"indicator":"Adx","period":14,"operator":"GreaterThan","value":22}} }
]}
```

Wrap as full DSL ParametersJson:

```json
{
  "Name": "<descriptive name>",
  "Symbol": "<EURUSD>",
  "Timeframe": "<H1>",
  "Direction": "<Buy|Sell>",
  "EntryConditionsRoot": <tree from above>,
  "StopLossAtrMultiplier": <1.5–2.5>,
  "TakeProfitAtrMultiplier": <2.0–3.5>,
  "AtrPeriod": <10–20>,
  "BaseConfidence": <0.5–0.7>
}
```

### 6. Create + trigger each candidate

For each candidate (call sequentially — keeps log output legible and lets you abort if the first one fails):

```bash
# Create strategy
RESP=$(curl -s -X POST http://localhost:5081/api/v1/lascodia-trading-engine/strategy \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$STRATEGY_JSON")
SID=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'] if d.get('status') else '')")
[ -z "$SID" ] && echo "create failed: $RESP" && continue

# Trigger optimization (Manual bypasses the regime-stability gate)
TRESP=$(curl -s -X POST http://localhost:5081/api/v1/lascodia-trading-engine/strategy-feedback/optimization/trigger \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"strategyId\":$SID,\"triggerType\":\"Manual\"}")
RID=$(echo "$TRESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'] if d.get('status') else '')")
echo "queued: sid=$SID rid=$RID name=$NAME"
```

The `CreateStrategyCommand` shape (camelCase fields):

```json
{
  "name": "...",
  "description": "...",
  "strategyType": "...",
  "symbol": "...",
  "timeframe": "...",
  "parametersJson": "<JSON-encoded string>"
}
```

`parametersJson` is a **string** containing the JSON, not a nested object. Stringify before sending.

### 7. Poll to terminal

Use a background poll task (don't block your conversation turn synchronously for 30+ minutes). Pattern:

```bash
RIDS="65,66,67"  # comma-separated run ids you queued
nohup bash -c '
  while true; do
    NON_TERM=$(docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -tAc \
      "SELECT COUNT(*) FROM \"OptimizationRun\" WHERE \"Id\" IN ('"$RIDS"') AND \"Status\" NOT IN (\x27Completed\x27,\x27Failed\x27,\x27Cancelled\x27);")
    [ "$NON_TERM" = "0" ] && echo "all terminal" && break
    sleep 30
  done
' > /tmp/strategy-hunt-$$.log 2>&1 &
```

Run via the Bash tool with `run_in_background: true`. Note the task id, then call **ScheduleWakeup** with `delaySeconds: 1800` and `prompt: "/strategy-hunt resume <runIds>"` so you come back when runs are likely done.

When woken: query the runs, evaluate, report. If still in flight, ScheduleWakeup again with 1200s.

A simpler mode (smaller batches, willing to wait): poll synchronously up to ~10 minutes; if any run hasn't terminated, write a partial report and let the user re-invoke to see final results.

### 8. Evaluate & report

```sql
SELECT r."Id", r."StrategyId", s."Name", s."StrategyType", s."Symbol", s."Timeframe",
       r."Status", r."FailureCategory", r."Iterations",
       r."BaselineHealthScore", r."BestHealthScore",
       r."BestSharpeRatio", r."BestMaxDrawdownPct", r."BestWinRate",
       r."ErrorMessage"
FROM "OptimizationRun" r JOIN "Strategy" s ON s."Id" = r."StrategyId"
WHERE r."Id" IN (<your run ids>)
ORDER BY r."Id";
```

Print a concise table:

```
WIN  rid=66 sid=185 EURGBP H1 BBReversion   baseline 0.51 → best 0.58  (Sharpe 0.42, DD 8.1%, WR 56%)
loss rid=67 sid=186 USDJPY H1 RSIReversion  search exhausted, 11 candidates evaluated
```

Mark wins with `WIN`, score regressions with `flat`, terminal failures with `loss`.

### 9. Save insights to memory

After the batch report, write a short memory entry under `~/.claude/projects/-Users-olabodeolaleye-Developments-Software-Projects-personal-Lascodia-Trading-Engine-lascodia-trading-engine-admin-ui/memory/` summarizing what won and what's been failing repeatedly. Update an existing `project_strategy_hunt_signals.md` if it exists; create it (and add a pointer in `MEMORY.md`) on first run.

The memory should be terse and high-signal: which (Symbol, Timeframe, StrategyType) combos cleared validation, which keep getting search-exhausted. This biases future batches.

Don't save iteration counts or transient state — those go stale fast.

### 10. Final user-facing summary

End the turn with one or two short sentences: how many created, how many won, names of any winners. The user should be able to glance at it and know whether to keep looping.

## Pairing with /loop

For continuous discovery the user wraps this skill: `/loop /strategy-hunt` (dynamic mode — Claude self-paces) or `/loop 30m /strategy-hunt` (fixed cadence). The skill itself does **one batch and stops** — never recurse internally. /loop owns the cadence.

If invoked under /loop and the queue is saturated (step 2), exit cleanly and quickly so /loop's next tick gets a fresh chance.

## Hard rules

- **Never** delete strategies or runs as part of the skill (don't tidy up "failed" candidates — they're signal). Soft-delete a candidate only if creation succeeded but the trigger call failed and it's an orphan.
- **Always** use `triggerType: "Manual"` — this bypasses the regime-stability gate.
- **Always** stringify `parametersJson` before sending to the API.
- **Don't** create more than 6 strategies per batch — the worker's `MaxConcurrentRuns` is small and oversaturating queues a backlog that delays feedback.
- **Don't** call `/auth/token` in production — it only works when `ASPNETCORE_ENVIRONMENT=Development`.

## On failure modes

- Engine 401 → token expired or roles wrong; re-fetch with `["Operator","Analyst"]`.
- Engine 500 on POST /strategy → likely a schema validation error in the body; print the response and skip that candidate.
- All runs Failed with `Search exhausted: N candidates, none passed validation` → the validation gates are doing their job; this is expected for most candidates. Note the pattern in memory; don't treat as a bug.
- `MaxConcurrentRuns` config row absent → use 2 as the safe default.

## Quick reference: minimal invocation

```bash
# 1 token
TOKEN=$(curl -s -X POST http://localhost:5081/api/v1/lascodia-trading-engine/auth/token \
  -H "Content-Type: application/json" \
  -d '{"userId":"strategy-hunt","email":"hunt@dev.local","firstName":"Hunt","lastName":"Skill","roles":["Operator","Analyst"]}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# 2 create strategy (note: parametersJson is a string)
PARAMS='{"FastPeriod":12,"SlowPeriod":34,"MaType":"Ema","AtrPeriod":14,"StopLossAtrMultiplier":2.0,"TakeProfitAtrMultiplier":3.0}'
BODY=$(python3 -c "import json; print(json.dumps({'name':'Hunt EURUSD H1 EMA','description':'auto-generated','strategyType':'MovingAverageCrossover','symbol':'EURUSD','timeframe':'H1','parametersJson':'$PARAMS'}))")
SID=$(curl -s -X POST http://localhost:5081/api/v1/lascodia-trading-engine/strategy \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'])")

# 3 trigger
RID=$(curl -s -X POST http://localhost:5081/api/v1/lascodia-trading-engine/strategy-feedback/optimization/trigger \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"strategyId\":$SID,\"triggerType\":\"Manual\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'])")

echo "queued sid=$SID rid=$RID"
```

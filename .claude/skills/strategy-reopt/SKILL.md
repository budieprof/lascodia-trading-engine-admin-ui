---
name: strategy-reopt
description: Bulk re-trigger Manual optimization runs against existing Lascodia strategies based on filters (symbol, type, lifecycle, staleness, prior-outcome) or an explicit id list. Sibling of /strategy-hunt — this skill never creates new strategies, only re-optimizes ones that already exist. Useful after a code fix, grid change, or to refresh stale results.
---

# /strategy-reopt — bulk re-optimize existing strategies

You are queuing Manual optimization runs against strategies that already exist in the Lascodia engine. **You will not create new strategies in this skill — that's `/strategy-hunt`'s job.**

The engine runs at `http://localhost:5081`; Postgres is in `lascodia-trading-engine-postgres-1`. Both must be reachable.

## Input

Parse the user's args (whitespace-delimited tokens). All filters AND together; if multiple values for the same filter are provided, the last wins. Recognized tokens:

- `ids=10,42,176` — explicit comma-separated strategy ids; if present, all other filters are ignored.
- `symbol=USDJPY` — exact match on `Strategy.Symbol`.
- `timeframe=H1` — exact match on `Strategy.Timeframe`.
- `type=RuleBased` — exact match on `Strategy.StrategyType`.
- `lifecycle=Draft|Approved|Paused|Pruned|...` — exact match on `LifecycleStage` (default: exclude `Pruned` + `Decommissioned`).
- `previous=won|completed|failed|never` — the outcome of the **most recent** non-deleted opt run on each candidate strategy. `won` means Completed AND `BestHealthScore > BaselineHealthScore`. `never` means the strategy has no opt runs yet.
- `stale=<days>` — only include strategies whose most recent opt was queued more than N days ago, OR have never been optimized. Default when no other prior-run filter is set: `stale=14`.
- `limit=N` (default `5`) — cap the number queued in this invocation.
- `dry-run` — print the resolved target set + plan, but do **not** call the trigger endpoint.
- `confirm` — auto-confirm without showing the plan first (use sparingly; prefer the dry-run preview by default for batches > 3).

If no args at all: `limit=5`, `stale=14`, exclude pruned/decommissioned, exclude strategies currently in flight, `dry-run` OFF but show the plan and ask before triggering when count > 3.

## Hard rules

- **Never** queue a strategy that already has an opt run in `Queued`, `Running`, or `Claimed` state — would duplicate work and oversaturate the worker.
- **Never** create new strategies. If the resolved target set is empty, report that and exit cleanly.
- **Always** use `triggerType: "Manual"` so the regime-stability gate is bypassed.
- **Respect `MaxConcurrentRuns`** — if `inFlight + targetCount > MaxConcurrentRuns`, trim the target set down (keep the highest-priority items: most stale first, then `previous=won` first).
- The `/auth/token` endpoint is dev-only — abort if `ASPNETCORE_ENVIRONMENT` isn't `Development`.

## Workflow

### 1. Preflight (same as /strategy-hunt)

```bash
curl -sf -o /dev/null -w "engine: %{http_code}\n" http://localhost:5081/health
docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -tAc "SELECT 1;"
TOKEN=$(curl -s -X POST http://localhost:5081/api/v1/lascodia-trading-engine/auth/token \
  -H "Content-Type: application/json" \
  -d '{"userId":"strategy-reopt","firstName":"Reopt","lastName":"Skill","email":"reopt@dev.local","roles":["Operator","Analyst"]}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
```

### 2. Capacity check

```sql
SELECT COUNT(*) FROM "OptimizationRun"
WHERE "Status" IN ('Queued','Running','Claimed') AND NOT "IsDeleted";
```

`MaxConcurrentRuns` lives in `EngineConfig` (key `Optimization:MaxConcurrentRuns` or similar) — check there; if absent, default to **2**. If `inFlight ≥ MaxConcurrentRuns`, exit with "Queue saturated, skipping batch" so /loop ticks can come back later.

### 3. Resolve the target set

Build a single SQL query from the filters. Skeleton:

```sql
WITH last_runs AS (
  SELECT DISTINCT ON (r."StrategyId")
    r."StrategyId", r."Status", r."BestHealthScore", r."BaselineHealthScore", r."QueuedAt"
  FROM "OptimizationRun" r
  WHERE NOT r."IsDeleted"
  ORDER BY r."StrategyId", r."QueuedAt" DESC
),
in_flight AS (
  SELECT DISTINCT "StrategyId" FROM "OptimizationRun"
  WHERE "Status" IN ('Queued','Running','Claimed') AND NOT "IsDeleted"
)
SELECT s."Id", s."Name", s."Symbol", s."Timeframe", s."StrategyType",
       s."LifecycleStage", lr."Status" AS last_status, lr."QueuedAt" AS last_queued,
       (lr."Status" = 'Completed' AND lr."BestHealthScore" > lr."BaselineHealthScore") AS last_won
FROM "Strategy" s
LEFT JOIN last_runs lr ON lr."StrategyId" = s."Id"
WHERE NOT s."IsDeleted"
  AND s."Id" NOT IN (SELECT "StrategyId" FROM in_flight)
  -- AND filter clauses appended below per args
ORDER BY (lr."QueuedAt" IS NULL) DESC, lr."QueuedAt" ASC NULLS FIRST, s."Id"
LIMIT <limit>;
```

Filter clauses to append:

| Arg                  | Clause                                                                              |
| -------------------- | ----------------------------------------------------------------------------------- |
| `ids=`               | `AND s."Id" IN (<ids>)` (exclusive — skip all other filters)                        |
| `symbol=`            | `AND s."Symbol" = '<sym>'`                                                          |
| `timeframe=`         | `AND s."Timeframe" = '<tf>'`                                                        |
| `type=`              | `AND s."StrategyType" = '<type>'`                                                   |
| `lifecycle=`         | `AND s."LifecycleStage" = '<stage>'`                                                |
| (default)            | `AND s."LifecycleStage" NOT IN ('Pruned','Decommissioned')`                         |
| `previous=won`       | `AND lr."Status" = 'Completed' AND lr."BestHealthScore" > lr."BaselineHealthScore"` |
| `previous=completed` | `AND lr."Status" = 'Completed'`                                                     |
| `previous=failed`    | `AND lr."Status" = 'Failed'`                                                        |
| `previous=never`     | `AND lr."StrategyId" IS NULL`                                                       |
| `stale=<N>`          | `AND (lr."QueuedAt" IS NULL OR lr."QueuedAt" < NOW() - INTERVAL '<N> days')`        |

Order: NEVER-optimized first (most informative new signal), then oldest opt first.

When `ids=` is provided, validate every id exists and isn't deleted; print a warning for each id that didn't resolve, then proceed with the rest.

### 4. Show the plan (unless `confirm` or `dry-run`)

For batches > 3, print the resolved set as a table:

```
Will queue 5 Manual optimization runs:
  sid 176  AUDUSD H1 MovingAverageCrossover   last: Failed (2d ago)
  sid 178  USDJPY H1 RuleBased                last: Failed (2d ago)
  sid 179  AUDUSD H1 RuleBased                last: Failed (2d ago)
  sid 187  NZDUSD H1 BollingerBandReversion   last: never
  sid 186  GBPJPY H1 RuleBased                last: never
```

Then ask the user once: "Queue these N runs? (y/N)" — accept y/Y/yes; anything else aborts. If `confirm` was passed, skip the prompt. If `dry-run` was passed, print the plan and **stop without triggering**.

### 5. Trigger each

```bash
trigger_one() {
  local SID="$1"
  local RESP=$(curl -s -X POST http://localhost:5081/api/v1/lascodia-trading-engine/strategy-feedback/optimization/trigger \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"strategyId\":$SID,\"triggerType\":\"Manual\"}")
  local RID=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data','') if d.get('status') else '')")
  if [ -z "$RID" ]; then
    echo "  TRIGGER FAILED for sid=$SID: $RESP"
    return 1
  fi
  echo "  queued: sid=$SID rid=$RID"
  echo "$SID:$RID" >> /tmp/reopt-batch.log
}
```

Don't fail the whole batch on one trigger error — log it and keep going.

### 6. Background poll + report

Identical to `/strategy-hunt` step 7. Spawn a `nohup bash` poll loop watching the run ids; the polling pattern is documented in `/strategy-hunt`.

When woken (via /loop or manually), query the runs and print a result table:

```
WIN  rid=70 sid=176 AUDUSD H1 MovingAverageCrossover  baseline 0.22 → best 0.41  (Sharpe 0.18, DD 11%, WR 51%)
flat rid=71 sid=178 USDJPY H1 RuleBased               baseline 0.38 → best 0.36  (regression, not promoted)
loss rid=72 sid=179 AUDUSD H1 RuleBased               search exhausted, 152 candidates evaluated
```

`WIN` = Completed AND best > baseline. `flat` = Completed but no improvement. `loss` = Failed/Cancelled.

### 7. Memory updates

After the report, if any results contradict prior memory (e.g., a combo previously flagged as "consistently fails validation" just won), update the relevant project-memory entry. Don't write generic "we ran a batch" memories — only persist insights that change the picture.

## Pairing with /loop

If the user wraps with `/loop /strategy-reopt`, the natural cadence is wider than `/strategy-hunt` because re-optimization needs strategies whose state has _changed_ — usually after manual code or grid edits. A 1-hour interval is reasonable; 1500-1800s ScheduleWakeup in dynamic mode is fine. If the resolved set is empty on consecutive ticks, consider widening the staleness window or stopping the loop (`omit ScheduleWakeup`).

## Failure modes

- All targets already in flight → "Nothing to do, all candidates already running" → exit cleanly.
- Resolved set empty after filters → print the SQL and the empty result; suggest looser filters.
- 401 on trigger → token expired or roles wrong; re-fetch with `["Operator","Analyst"]`.
- 404 on a specific `ids=<n>` → strategy doesn't exist (or is deleted); skip it, warn, continue.

## Quick reference: minimal invocations

```text
/strategy-reopt                         # default: 5 stale strategies, show plan, confirm
/strategy-reopt ids=176,178,179         # exact ids
/strategy-reopt symbol=USDJPY confirm   # all USDJPY strategies past staleness, no confirm prompt
/strategy-reopt previous=won limit=3    # re-run the top 3 stalest prior winners
/strategy-reopt previous=never          # optimize anything that's never been touched
/strategy-reopt type=RuleBased dry-run  # preview which RuleBased ones would run
```

---
name: ml-train
description: Trigger ML model training in the Lascodia engine and monitor end-to-end through the full lifecycle (Queued → Running → Completed/Failed → MLModel.Active → PendingModel-strategy promotion). Default mode discovers all (Symbol, Timeframe) pairs that have PendingModel CompositeML strategies and queues training for each. Pair with /loop for continuous training.
---

# /ml-train — trigger and monitor ML model training end-to-end

You are queuing one or more ML training runs against the Lascodia engine and watching them through the **full** lifecycle:

```
MLTrainingRun:  Queued → Running → Completed/Failed
                                        ↓ (on Completed)
MLModel:        (created) → Active
                    ↓ (publishes MLModelActivatedIntegrationEvent)
Strategy:       LifecycleStage 'PendingModel' → 'Draft' for matching (Symbol, Timeframe)
```

The engine runs at `http://localhost:5081`; Postgres is `lascodia-trading-engine-postgres-1` / db `LascodiaTradingEngineDb`.

## Input

Parse args (whitespace-delimited tokens). Modes:

- **No args** (default) → `pending` mode with `limit=3`.
- `pending` → discover all (Symbol, Timeframe) pairs whose Strategy rows have `LifecycleStage='PendingModel'` AND no Queued/Running training run already in flight; queue training for up to `limit` of them.
- `symbol=EURUSD timeframe=H1` → train this specific pair (skip `pending` discovery).

Optional refinements (apply to either mode):

- `from=YYYY-MM-DD` and `to=YYYY-MM-DD` — training data window. The engine needs **≥1500 training samples** (the `530 contiguous bars` rule is the _floor_; the actual gate is `MLTraining:MinTrainingSamples = 1500`). Pick the window by timeframe:
  - `M1`/`M5`/`M15` → default `from=today-90d`
  - `H1` → default `from=today-365d`
  - `H4` → default `from=today-720d` (need ~250+ trading days × 6 bars)
  - `D1` → default `from=today-2000d` (D1 requires roughly 5+ years to clear the 1500-sample bar)
    Override with explicit `from=`/`to=` when historical depth allows. If a trigger fails with "Training sample count N below minimum 1500", widen the window.
- `arch=<int>` — `LearnerArchitecture` enum (default `0` = auto-select).
- `limit=N` (default `3`) — cap for `pending` mode.
- `dry-run` — print plan, don't trigger.
- `confirm` — auto-confirm (skip the plan/ask prompt for batches > 3).

## Hard rules

- **Never** trigger a new training for a (Symbol, Timeframe) pair that already has a `Queued` or `Running` `MLTrainingRun`. Skip with a note.
- **Always** use `triggerType: "Manual"`.
- **Don't** lower the quality gates or retry permanently-failed runs from inside this skill — quality fails are signal.
- The `/auth/token` endpoint is dev-only; abort outside Development.
- Training takes minutes-to-hours; this skill **does not block synchronously** for completion. It triggers, kicks off background polling, optionally schedules a wakeup, and reports on whatever has terminated by the time it's woken.

## Workflow

### 1. Preflight + token

```bash
curl -sf -o /dev/null -w "engine: %{http_code}\n" http://localhost:5081/health
docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -tAc "SELECT 1;"
TOKEN=$(curl -s -X POST http://localhost:5081/api/v1/lascodia-trading-engine/auth/token \
  -H "Content-Type: application/json" \
  -d '{"userId":"ml-train","firstName":"ML","lastName":"Skill","email":"ml@dev.local","roles":["Operator","Analyst"]}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
```

Analyst role is enough for triggering, but Operator gives access to activation/rollback endpoints if needed for diagnostics.

### 2. Resolve the target set

For `pending` mode (default):

```sql
WITH in_flight AS (
  SELECT DISTINCT "Symbol", "Timeframe" FROM "MLTrainingRun"
  WHERE "Status" IN ('Queued','Running')
)
SELECT s."Symbol", s."Timeframe", COUNT(*) AS pending_strategies, ARRAY_AGG(s."Id") AS sids
FROM "Strategy" s
WHERE s."LifecycleStage" = 'PendingModel'
  AND NOT s."IsDeleted"
  AND (s."Symbol", s."Timeframe") NOT IN (SELECT "Symbol", "Timeframe" FROM in_flight)
GROUP BY s."Symbol", s."Timeframe"
ORDER BY pending_strategies DESC, s."Symbol", s."Timeframe"
LIMIT <limit>;
```

For an explicit `symbol=`/`timeframe=` mode, just validate that pair isn't in flight; if it is, refuse and exit.

If the resolved set is empty, print "No pending pairs to train" and exit cleanly so /loop ticks come back later.

### 3. Plan / confirmation

For batches > 3, print the planned target set and ask once: `Queue N training runs? (y/N)`. Skip the prompt if `confirm` was passed. If `dry-run`, print and exit.

### 4. Trigger each pair

Compute the date window per-timeframe (override per-pair as needed). Helper:

```bash
days_for_tf() {
  case "$1" in
    M1|M5|M15) echo 90 ;;
    H1) echo 365 ;;
    H4) echo 720 ;;
    D1) echo 2000 ;;
    *) echo 365 ;;
  esac
}
TO_DATE=$(date -u +%Y-%m-%d)
days=$(days_for_tf "$TF")
FROM_DATE=$(date -u -v-${days}d +%Y-%m-%d 2>/dev/null || date -u -d "${days} days ago" +%Y-%m-%d)
```

(macOS uses `-v`, Linux uses `-d`.)

```bash
trigger_one() {
  local SYM="$1" TF="$2"
  local BODY=$(python3 -c "
import json
print(json.dumps({
  'symbol': '$SYM',
  'timeframe': '$TF',
  'fromDate': '$FROM_DATE',
  'toDate': '$TO_DATE',
  'triggerType': 'Manual',
  'learnerArchitecture': $ARCH
}))")
  local RESP=$(curl -s -X POST http://localhost:5081/api/v1/lascodia-trading-engine/ml-model/training/trigger \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$BODY")
  local RID=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data','') if d.get('status') else '')")
  if [ -z "$RID" ]; then
    echo "  TRIGGER FAILED for $SYM $TF: $RESP"
    return 1
  fi
  echo "  queued: $SYM $TF runId=$RID"
  echo "$RID:$SYM:$TF" >> /tmp/ml-train-batch.log
}
```

Pre-flight rejections to expect:

- `responseCode: "-11"` with `Validation failed`: usually fewer than 530 candles in the window — widen the window (`from=` further back) or pick a more-traded symbol.
- Architecture-not-supported: the host has no libtorch (Apple Silicon often). Pass `arch=0` and let the engine auto-pick a CPU-only architecture, or query `/ml-model/training/available-architectures`.

### 5. Monitor end-to-end

Spawn a background poll watching the run ids. The loop reports state transitions, NOT just terminal events — training takes time and progress visibility matters.

```bash
RIDS="$1"  # comma-separated run ids
nohup bash -c '
  RIDS="'"$RIDS"'"
  declare -A LAST
  while true; do
    while IFS="|" read RID STATUS ATT MAX EM; do
      [ -z "$RID" ] && continue
      KEY="$RID"
      if [ "${LAST[$KEY]:-}" != "$STATUS" ]; then
        echo "$(date +%H:%M:%S) rid=$RID -> $STATUS attempt=$ATT/$MAX ${EM:+err=$EM}"
        LAST[$KEY]="$STATUS"
      fi
    done < <(docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -tAc \
      "SELECT \"Id\"||'\''|'\''||\"Status\"||'\''|'\''||\"AttemptCount\"||'\''|'\''||\"MaxAttempts\"||'\''|'\''||COALESCE(LEFT(\"ErrorMessage\",60),'\'\'') FROM \"MLTrainingRun\" WHERE \"Id\" IN ('"$RIDS"');")
    NON_TERM=$(docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -tAc \
      "SELECT COUNT(*) FROM \"MLTrainingRun\" WHERE \"Id\" IN ('"$RIDS"') AND \"Status\" NOT IN ('"'"'Completed'"'"','"'"'Failed'"'"');")
    [ "$NON_TERM" = "0" ] && echo "all terminal" && break
    sleep 30
  done
' > /tmp/ml-train-poll.log 2>&1 &
disown
```

When all training runs are terminal, also follow the integration chain:

```sql
-- Models created from this batch
SELECT m."Id", m."Symbol", m."Timeframe", m."Status", m."DirectionAccuracy",
       m."F1Score", m."SharpeRatio", m."BrierScore", m."CreatedAt"
FROM "MLModel" m
WHERE m."Id" IN (SELECT "MLModelId" FROM "MLTrainingRun" WHERE "Id" IN (<rids>) AND "MLModelId" IS NOT NULL)
ORDER BY m."Id";

-- Strategies that should have been promoted out of PendingModel
SELECT s."Id", s."Symbol", s."Timeframe", s."Name", s."LifecycleStage"
FROM "Strategy" s
WHERE NOT s."IsDeleted"
  AND (s."Symbol", s."Timeframe") IN (SELECT "Symbol", "Timeframe" FROM "MLTrainingRun" WHERE "Id" IN (<rids>) AND "Status" = 'Completed')
ORDER BY s."Symbol", s."Timeframe";
```

If a training Completed but the Strategy row is still in `PendingModel`, the promotion event handler may have failed — flag it (don't try to fix it from here; it's a code bug).

### 6. Report

Final summary table per training run:

```
WIN  rid=3580 EURJPY H4  ✓Completed  acc=0.612  f1=0.58  sharpe=0.41  brier=0.2031   model=#142 Active   promoted: sid 90
loss rid=3581 USDCHF H4  ✗Failed     attempt 1/3, retry at 14:32   "Quality gate failed: accuracy 49.1% < 55.0%"
loss rid=3582 GBPJPY D1  ✗Failed     attempt 3/3, permanent      "Permanently failed: training sample count below threshold"
```

Mark with `WIN` only when all three legs pass:

1. Training Completed
2. MLModel created with Status=Active
3. At least one PendingModel strategy promoted (LifecycleStage moved off `PendingModel`)

Anything else (Failed, retry-pending, model created but not Active, no strategy promoted) is `loss`/`partial`.

### 7. Memory

After the report, persist any **non-obvious** insight to project memory under `~/.claude/projects/.../memory/`:

- `(Symbol, Timeframe)` pairs that consistently fail the quality gate after multiple attempts → mark as deprioritized in `project_strategy_hunt_signals.md` (don't queue more PendingModel CompositeML strategies for those pairs).
- Pairs where training Completed but strategy promotion didn't happen → save as a project memory of a likely promotion-handler bug.
- Pairs whose first-time training succeeds → useful signal for future picks.

Don't save raw run IDs / per-batch counts — those go stale fast.

### 8. /loop pairing

Wrap with `/loop /ml-train pending` for continuous training discovery. Dynamic-mode delay: trainings can take minutes to hours, so a 1500–1800s wakeup is appropriate. If the resolved set is empty on consecutive ticks, pause the loop or widen the date window.

## Failure modes & expectations

- **High failure rate is normal.** Historical: ~70% Failed, mostly on quality gates (accuracy/brier/sharpe below threshold). This is the system working — bad models stay out.
- **Permanent failures** (`AttemptCount = MaxAttempts`) are typically: insufficient training samples, label imbalance, or systematic accuracy below threshold. Don't retry these from the skill.
- **Architecture not supported**: pass `arch=0` to let the engine auto-select.
- **Window too narrow**: needs ≥530 contiguous bars in the (FromDate, ToDate) window. Widen if rejected.
- **`MLModelActivatedIntegrationEvent` not propagating**: if Completed + MLModel exists with Status=Active but PendingModel strategies aren't promoted within ~60s, that's a handler bug — surface it but don't try to patch from inside the skill.

## Quick reference

```bash
# train a specific pair
curl -X POST http://localhost:5081/api/v1/lascodia-trading-engine/ml-model/training/trigger \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"symbol":"EURUSD","timeframe":"H1","fromDate":"2025-11-06","toDate":"2026-05-06","triggerType":"Manual","learnerArchitecture":0}'

# watch progress
docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -c \
  "SELECT \"Id\",\"Symbol\",\"Timeframe\",\"Status\",\"AttemptCount\",\"DirectionAccuracy\",\"F1Score\",\"SharpeRatio\",\"BrierScore\",LEFT(COALESCE(\"ErrorMessage\",''),80) AS err FROM \"MLTrainingRun\" WHERE \"Id\" = <rid>;"

# verify model + promotion
docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -c \
  "SELECT m.\"Id\",m.\"Status\",m.\"DirectionAccuracy\" FROM \"MLModel\" m JOIN \"MLTrainingRun\" r ON r.\"MLModelId\"=m.\"Id\" WHERE r.\"Id\" = <rid>;"
docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -c \
  "SELECT \"Id\",\"Name\",\"LifecycleStage\" FROM \"Strategy\" WHERE \"Symbol\"='<sym>' AND \"Timeframe\"='<tf>' AND NOT \"IsDeleted\";"

# discover pending pairs
docker exec lascodia-trading-engine-postgres-1 psql -U postgres -d LascodiaTradingEngineDb -c \
  "SELECT \"Symbol\",\"Timeframe\",COUNT(*) FROM \"Strategy\" WHERE \"LifecycleStage\"='PendingModel' AND NOT \"IsDeleted\" GROUP BY 1,2 ORDER BY 3 DESC;"
```

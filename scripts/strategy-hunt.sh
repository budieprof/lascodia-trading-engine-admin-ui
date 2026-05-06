#!/usr/bin/env bash
# strategy-hunt.sh — one batch of generate + backtest + optimize against the local Lascodia engine
# Independent of Claude Code; safe to run from system cron or a `while true; sleep 420; ...` shell loop.

set -euo pipefail

ENGINE_URL="${ENGINE_URL:-http://localhost:5081}"
PG_CONTAINER="${PG_CONTAINER:-lascodia-trading-engine-postgres-1}"
PG_DB="${PG_DB:-LascodiaTradingEngineDb}"
PG_USER="${PG_USER:-postgres}"
LOG="${HUNT_LOG:-/tmp/strategy-hunt-loop.log}"

ts() { date +%Y-%m-%dT%H:%M:%S; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

if ! curl -sf -o /dev/null "$ENGINE_URL/health"; then
  log "engine $ENGINE_URL/health not reachable, skipping batch"
  exit 0
fi

TOKEN=$(curl -s -X POST "$ENGINE_URL/api/v1/lascodia-trading-engine/auth/token" \
  -H "Content-Type: application/json" \
  -d '{"userId":"strategy-hunt-loop","firstName":"Hunt","lastName":"Loop","email":"hunt-loop@dev.local","roles":["Operator","Analyst"]}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

if [[ -z "$TOKEN" ]]; then
  log "failed to acquire token, skipping batch"
  exit 0
fi

# Capacity check — count only runs the worker is actively touching.
# Deferred runs (DeferredUntilUtc in the future) are sleeping, not consuming worker capacity.
INFLIGHT=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
  "SELECT COUNT(*) FROM \"OptimizationRun\"
   WHERE \"Status\" IN ('Queued','Running','Claimed')
     AND NOT \"IsDeleted\"
     AND (\"DeferredUntilUtc\" IS NULL OR \"DeferredUntilUtc\" < NOW());")
if [[ "${INFLIGHT:-0}" -ge 4 ]]; then
  log "queue saturated (in-flight=$INFLIGHT non-deferred), skipping batch"
  exit 0
fi

TO_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FROM_ISO=$(date -u -v-180d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '180 days ago' +%Y-%m-%dT%H:%M:%SZ)

# Candidate library — sampled at random each batch.
# Each entry: NAME|TYPE|SYMBOL|TIMEFRAME|PARAMS_JSON
CANDIDATES=(
  # Yen+breakout family (proven winners — biased heavier in the rotation)
  "Hunt EURJPY H1 Breakout|BreakoutScalper|EURJPY|H1|{\"LookbackBars\":20,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":1.5,\"TakeProfitAtrMultiplier\":2.5}"
  "Hunt EURJPY M15 Breakout|BreakoutScalper|EURJPY|M15|{\"LookbackBars\":18,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":1.4,\"TakeProfitAtrMultiplier\":2.4}"
  "Hunt GBPJPY M15 Breakout|BreakoutScalper|GBPJPY|M15|{\"LookbackBars\":22,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":1.6,\"TakeProfitAtrMultiplier\":2.6}"
  "Hunt GBPJPY H4 Breakout|BreakoutScalper|GBPJPY|H4|{\"LookbackBars\":24,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":1.8,\"TakeProfitAtrMultiplier\":2.8}"
  "Hunt USDJPY H1 Breakout|BreakoutScalper|USDJPY|H1|{\"LookbackBars\":20,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":1.5,\"TakeProfitAtrMultiplier\":2.5}"
  "Hunt USDJPY H4 Breakout|BreakoutScalper|USDJPY|H4|{\"LookbackBars\":22,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":1.7,\"TakeProfitAtrMultiplier\":2.7}"
  "Hunt USDJPY H4 SessionBreak|SessionBreakout|USDJPY|H4|{\"BreakoutStartHour\":7,\"BreakoutEndHour\":16,\"RangeStartHourUtc\":2,\"RangeEndHourUtc\":7,\"ThresholdMultiplier\":0.7,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":1.5,\"TakeProfitAtrMultiplier\":2.5}"
  "Hunt EURJPY H1 SessionBreak|SessionBreakout|EURJPY|H1|{\"BreakoutStartHour\":6,\"BreakoutEndHour\":15,\"RangeStartHourUtc\":1,\"RangeEndHourUtc\":6,\"ThresholdMultiplier\":0.65,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":1.5,\"TakeProfitAtrMultiplier\":2.5}"
  # RSI reversion family
  "Hunt GBPUSD H1 RSI|RSIReversion|GBPUSD|H1|{\"Period\":14,\"Oversold\":28,\"Overbought\":72,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":2.0,\"TakeProfitAtrMultiplier\":3.0}"
  "Hunt AUDUSD H1 RSI|RSIReversion|AUDUSD|H1|{\"Period\":14,\"Oversold\":28,\"Overbought\":72,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":2.0,\"TakeProfitAtrMultiplier\":3.0}"
  "Hunt NZDUSD H1 RSI|RSIReversion|NZDUSD|H1|{\"Period\":12,\"Oversold\":25,\"Overbought\":75,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":1.8,\"TakeProfitAtrMultiplier\":2.8}"
  "Hunt USDCHF H1 RSI|RSIReversion|USDCHF|H1|{\"Period\":14,\"Oversold\":28,\"Overbought\":72,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":2.0,\"TakeProfitAtrMultiplier\":3.0}"
  # MACD divergence
  "Hunt EURUSD H4 MACD|MACDDivergence|EURUSD|H4|{\"FastPeriod\":12,\"SlowPeriod\":26,\"SignalPeriod\":9,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":2.0,\"TakeProfitAtrMultiplier\":3.0}"
  "Hunt GBPUSD H4 MACD|MACDDivergence|GBPUSD|H4|{\"FastPeriod\":12,\"SlowPeriod\":26,\"SignalPeriod\":9,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":2.0,\"TakeProfitAtrMultiplier\":3.0}"
  # Momentum trend
  "Hunt USDCAD H1 Momentum|MomentumTrend|USDCAD|H1|{\"MomentumPeriod\":14,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":2.0,\"TakeProfitAtrMultiplier\":3.0}"
  "Hunt AUDUSD H4 Momentum|MomentumTrend|AUDUSD|H4|{\"MomentumPeriod\":14,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":2.0,\"TakeProfitAtrMultiplier\":3.5}"
  # Bollinger
  "Hunt NZDUSD H4 BB|BollingerBandReversion|NZDUSD|H4|{\"Period\":20,\"StdDevMult\":2.2,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":1.2,\"TakeProfitAtrMultiplier\":2.2}"
  "Hunt EURGBP H1 BB|BollingerBandReversion|EURGBP|H1|{\"Period\":24,\"StdDevMult\":2.4,\"AtrPeriod\":14,\"StopLossAtrMultiplier\":1.3,\"TakeProfitAtrMultiplier\":2.3}"
  # RuleBased — regime-confirmed (pattern-hygiene: event signal + regime filter)
  "Hunt USDJPY H1 RB Pullback|RuleBased|USDJPY|H1|{\"Name\":\"Hunt USDJPY H1 RB Pullback\",\"Symbol\":\"USDJPY\",\"Timeframe\":\"H1\",\"Direction\":\"Buy\",\"EntryConditionsRoot\":{\"Op\":\"And\",\"Children\":[{\"Leaf\":{\"Type\":\"IndicatorThreshold\",\"indicatorThreshold\":{\"indicator\":\"Rsi\",\"period\":14,\"operator\":\"LessThan\",\"value\":42}}},{\"Leaf\":{\"Type\":\"IndicatorComparison\",\"indicatorComparison\":{\"leftIndicator\":\"Ema\",\"leftPeriod\":50,\"rightIndicator\":\"Ema\",\"rightPeriod\":200,\"operator\":\"GreaterThan\"}}}]},\"StopLossAtrMultiplier\":1.5,\"TakeProfitAtrMultiplier\":2.5,\"AtrPeriod\":14,\"BaseConfidence\":0.6}"
  "Hunt GBPUSD H1 RB Fade|RuleBased|GBPUSD|H1|{\"Name\":\"Hunt GBPUSD H1 RB Fade\",\"Symbol\":\"GBPUSD\",\"Timeframe\":\"H1\",\"Direction\":\"Sell\",\"EntryConditionsRoot\":{\"Op\":\"And\",\"Children\":[{\"Leaf\":{\"Type\":\"IndicatorThreshold\",\"indicatorThreshold\":{\"indicator\":\"Rsi\",\"period\":14,\"operator\":\"GreaterThan\",\"value\":70}}},{\"Leaf\":{\"Type\":\"IndicatorComparison\",\"indicatorComparison\":{\"leftIndicator\":\"Ema\",\"leftPeriod\":50,\"rightIndicator\":\"Ema\",\"rightPeriod\":200,\"operator\":\"LessThan\"}}}]},\"StopLossAtrMultiplier\":2.0,\"TakeProfitAtrMultiplier\":3.0,\"AtrPeriod\":14,\"BaseConfidence\":0.6}"
)

# Exclude combos already live (avoid duplicates)
LIVE_COMBOS=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
  "SELECT \"Symbol\"||':'||\"Timeframe\"||':'||\"StrategyType\" FROM \"Strategy\" WHERE NOT \"IsDeleted\" AND \"LifecycleStage\" NOT IN ('Pruned','Decommissioned');" | tr '\n' '|')

# Pick up to 3 candidates not already live, in shuffled order
N_TO_QUEUE=3
SELECTED=()
for IDX in $(printf '%s\n' "${!CANDIDATES[@]}" | awk 'BEGIN{srand()} {print rand()" "$0}' | sort -k1n | awk '{print $2}'); do
  ENTRY="${CANDIDATES[$IDX]}"
  IFS='|' read -r NAME TYPE SYM TF PARAMS <<<"$ENTRY"
  KEY="$SYM:$TF:$TYPE"
  if [[ "$LIVE_COMBOS" == *"$KEY"* ]]; then
    continue
  fi
  SELECTED+=("$ENTRY")
  [[ ${#SELECTED[@]} -ge $N_TO_QUEUE ]] && break
done

if [[ ${#SELECTED[@]} -eq 0 ]]; then
  log "no fresh combos available (all in library are already live), skipping batch"
  exit 0
fi

log "batch start — queuing ${#SELECTED[@]} candidates (in-flight=$INFLIGHT)"

for ENTRY in "${SELECTED[@]}"; do
  IFS='|' read -r NAME TYPE SYM TF PARAMS <<<"$ENTRY"
  BODY=$(python3 -c "
import json,sys
print(json.dumps({
  'name': '$NAME',
  'description': 'Auto-generated by scripts/strategy-hunt.sh',
  'strategyType': '$TYPE',
  'symbol': '$SYM',
  'timeframe': '$TF',
  'parametersJson': '''$PARAMS'''
}))")
  SID=$(curl -s -X POST "$ENGINE_URL/api/v1/lascodia-trading-engine/strategy" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data','') if d.get('status') else '')")
  if [[ -z "$SID" ]]; then
    log "  CREATE FAILED: $NAME"
    continue
  fi
  BT=$(curl -s -X POST "$ENGINE_URL/api/v1/lascodia-trading-engine/backtest" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"strategyId\":$SID,\"symbol\":\"$SYM\",\"timeframe\":\"$TF\",\"fromDate\":\"$FROM_ISO\",\"toDate\":\"$TO_ISO\",\"initialBalance\":10000}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data','') if d.get('status') else '')")
  RID=$(curl -s -X POST "$ENGINE_URL/api/v1/lascodia-trading-engine/strategy-feedback/optimization/trigger" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"strategyId\":$SID,\"triggerType\":\"Manual\"}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data','') if d.get('status') else '')")
  log "  sid=$SID bt=$BT rid=$RID '$NAME'"
done

log "batch done"

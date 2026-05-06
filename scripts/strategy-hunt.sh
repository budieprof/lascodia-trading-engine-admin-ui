#!/usr/bin/env bash
# strategy-hunt.sh — one batch of generate + backtest + optimize against the local Lascodia engine.
# Independent of Claude Code; safe to run from launchd, system cron, or a `while true; sleep N; ...` loop.
#
# Each fire picks up to 3 (Symbol, Timeframe, StrategyType) tuples that haven't yet hit the per-combo
# cap (default 5 live strategies per tuple) and mints a unique strategy with randomized params for each.
# Backtest + walkforward auto-chain; optimization runs in parallel.

set -euo pipefail

ENGINE_URL="${ENGINE_URL:-http://localhost:5081}"
PG_CONTAINER="${PG_CONTAINER:-lascodia-trading-engine-postgres-1}"
PG_DB="${PG_DB:-LascodiaTradingEngineDb}"
PG_USER="${PG_USER:-postgres}"
LOG="${HUNT_LOG:-/tmp/strategy-hunt-loop.log}"

MAX_PER_COMBO="${MAX_PER_COMBO:-5}"
N_TO_QUEUE="${N_TO_QUEUE:-3}"

ts() { date +%Y-%m-%dT%H:%M:%S; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

if ! curl -sf -o /dev/null "$ENGINE_URL/health"; then
  log "engine not reachable, skipping batch"
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

# Combo library: (StrategyType, Symbol, Timeframe). Each tuple is sampled freely
# until it reaches MAX_PER_COMBO live strategies. The yen+breakout family
# (proven winners per memory) is over-represented to bias selection.
COMBOS=(
  # Yen + breakout family — biased heavier
  "BreakoutScalper:USDJPY:H1"
  "BreakoutScalper:USDJPY:H4"
  "BreakoutScalper:USDJPY:M15"
  "BreakoutScalper:GBPJPY:H1"
  "BreakoutScalper:GBPJPY:H4"
  "BreakoutScalper:GBPJPY:M15"
  "BreakoutScalper:EURJPY:H1"
  "BreakoutScalper:EURJPY:H4"
  "BreakoutScalper:EURJPY:M15"
  "SessionBreakout:USDJPY:H4"
  "SessionBreakout:USDJPY:H1"
  "SessionBreakout:GBPJPY:H1"
  "SessionBreakout:GBPJPY:H4"
  "SessionBreakout:EURJPY:H1"
  # RSI reversion
  "RSIReversion:GBPUSD:H1"
  "RSIReversion:AUDUSD:H1"
  "RSIReversion:NZDUSD:H1"
  "RSIReversion:USDCHF:H1"
  "RSIReversion:USDCAD:H1"
  "RSIReversion:EURGBP:H1"
  # MACD divergence
  "MACDDivergence:EURUSD:H4"
  "MACDDivergence:GBPUSD:H4"
  "MACDDivergence:USDJPY:H4"
  "MACDDivergence:AUDUSD:H4"
  # Momentum trend
  "MomentumTrend:USDCAD:H1"
  "MomentumTrend:AUDUSD:H4"
  "MomentumTrend:NZDUSD:H4"
  "MomentumTrend:GBPUSD:H1"
  # Bollinger
  "BollingerBandReversion:NZDUSD:H4"
  "BollingerBandReversion:EURGBP:H1"
  "BollingerBandReversion:USDCHF:H1"
  "BollingerBandReversion:AUDUSD:H4"
  # RuleBased — regime-confirmed (event signal + regime filter, never two contradicting events)
  "RuleBased:USDJPY:H1:rb_pullback_buy"
  "RuleBased:GBPUSD:H1:rb_fade_sell"
  "RuleBased:AUDUSD:H1:rb_pullback_buy"
  "RuleBased:EURJPY:H1:rb_fade_sell"
)

# Pull live counts per combo as a "SYM|TF|TYPE|N" newline-delimited blob.
# Avoids `declare -A` (bash 4+) so macOS's stock bash 3.2 works.
LIVE_COUNTS_BLOB=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
  "SELECT \"Symbol\"||'|'||\"Timeframe\"||'|'||\"StrategyType\"||'|'||COUNT(*)
   FROM \"Strategy\"
   WHERE NOT \"IsDeleted\" AND \"LifecycleStage\" NOT IN ('Pruned','Decommissioned')
   GROUP BY \"Symbol\", \"Timeframe\", \"StrategyType\";")

live_count_for() {
  local SYM="$1" TF="$2" TYPE="$3"
  echo "$LIVE_COUNTS_BLOB" \
    | awk -F'|' -v s="$SYM" -v t="$TF" -v y="$TYPE" \
        '$1==s && $2==t && $3==y { print $4; found=1; exit } END { if (!found) print 0 }'
}

# Shuffle combo indexes and pick the first N_TO_QUEUE under the per-combo cap
SELECTED=()
for IDX in $(seq 0 $((${#COMBOS[@]} - 1)) | awk 'BEGIN{srand()} {print rand()" "$0}' | sort -k1n | awk '{print $2}'); do
  ENTRY="${COMBOS[$IDX]}"
  TYPE="${ENTRY%%:*}"
  REST="${ENTRY#*:}"
  SYM="${REST%%:*}"
  REST2="${REST#*:}"
  TF="${REST2%%:*}"
  CUR=$(live_count_for "$SYM" "$TF" "$TYPE")
  if [[ "${CUR:-0}" -ge "$MAX_PER_COMBO" ]]; then
    continue
  fi
  SELECTED+=("$ENTRY")
  [[ ${#SELECTED[@]} -ge "$N_TO_QUEUE" ]] && break
done

if [[ ${#SELECTED[@]} -eq 0 ]]; then
  log "all combos at MAX_PER_COMBO=$MAX_PER_COMBO cap, skipping batch"
  exit 0
fi

TO_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Timeframe-aware backtest window. Sized so the auto-walkforward policy can fit
# the engine's required ≥3 non-overlapping anchored folds and so each OOS fold
# has enough bars for typical low-frequency rules to clear `MinTradesPerFold`.
# Mirrors scripts/ml-train.sh's lookback table.
days_for_backtest_tf() {
  case "$1" in
    M1|M5)  echo 180 ;;
    M15)    echo 365 ;;
    H1)     echo 720 ;;
    H4)     echo 1080 ;;
    D1)     echo 2000 ;;
    *)      echo 720 ;;
  esac
}

log "batch start — queuing ${#SELECTED[@]} candidates (in-flight=$INFLIGHT)"

# Parameter generator — Python emits the JSON; bash captures it.
# Each StrategyType has its own randomization range. RuleBased uses one of two
# regime-confirmed templates picked by the 4th element of the combo entry.
gen_params() {
  local TYPE="$1" SYM="$2" TF="$3" RB_KIND="${4:-}"
  python3 - <<PY
import json, random, sys, time
random.seed(time.time_ns() ^ hash(("$SYM","$TF","$TYPE","$RB_KIND")))
T = "$TYPE"
SYM = "$SYM"
TF  = "$TF"
RBK = "$RB_KIND"

def jr(a,b,p=2): return round(random.uniform(a,b), p)
def ji(a,b): return random.randint(a,b)

if T == "BreakoutScalper":
    print(json.dumps({
        "LookbackBars": ji(10, 30),
        "AtrPeriod": random.choice([10, 14, 20]),
        "StopLossAtrMultiplier": jr(1.0, 2.0),
        "TakeProfitAtrMultiplier": jr(1.5, 3.0),
    }))
elif T == "SessionBreakout":
    rs = ji(0, 6); re = rs + ji(2, 6)
    bs = re; be = bs + ji(6, 11)
    print(json.dumps({
        "RangeStartHourUtc": rs, "RangeEndHourUtc": re,
        "BreakoutStartHour": bs, "BreakoutEndHour": min(be, 23),
        "ThresholdMultiplier": jr(0.55, 0.85),
        "AtrPeriod": random.choice([10, 14, 20]),
        "StopLossAtrMultiplier": jr(1.2, 2.0),
        "TakeProfitAtrMultiplier": jr(1.5, 2.8),
    }))
elif T == "RSIReversion":
    print(json.dumps({
        "Period": ji(10, 18),
        "Oversold": ji(20, 32),
        "Overbought": ji(68, 80),
        "AtrPeriod": random.choice([10, 14, 20]),
        "StopLossAtrMultiplier": jr(1.5, 2.5),
        "TakeProfitAtrMultiplier": jr(2.0, 3.5),
    }))
elif T == "MACDDivergence":
    print(json.dumps({
        "FastPeriod": ji(8, 14),
        "SlowPeriod": ji(20, 32),
        "SignalPeriod": ji(7, 11),
        "AtrPeriod": random.choice([10, 14, 20]),
        "StopLossAtrMultiplier": jr(1.5, 2.5),
        "TakeProfitAtrMultiplier": jr(2.0, 3.5),
    }))
elif T == "MomentumTrend":
    print(json.dumps({
        "MomentumPeriod": ji(10, 20),
        "AtrPeriod": random.choice([10, 14, 20]),
        "StopLossAtrMultiplier": jr(1.5, 2.5),
        "TakeProfitAtrMultiplier": jr(2.0, 4.0),
    }))
elif T == "BollingerBandReversion":
    print(json.dumps({
        "Period": ji(15, 40),
        "StdDevMult": jr(1.8, 2.8),
        "AtrPeriod": random.choice([10, 14, 20]),
        "StopLossAtrMultiplier": jr(1.0, 1.8),
        "TakeProfitAtrMultiplier": jr(1.8, 2.8),
    }))
elif T == "RuleBased":
    direction = "Buy" if RBK.endswith("buy") else "Sell"
    rsi_op = "LessThan" if direction == "Buy" else "GreaterThan"
    rsi_val = ji(35, 48) if direction == "Buy" else ji(68, 78)
    ema_op = "GreaterThan" if direction == "Buy" else "LessThan"
    rule = {
        "Name": f"Hunt {SYM} {TF} RB {RBK} {ji(0,9999)}",
        "Symbol": SYM,
        "Timeframe": TF,
        "Direction": direction,
        "EntryConditionsRoot": {
            "Op": "And",
            "Children": [
                {"Leaf": {"Type":"IndicatorThreshold","indicatorThreshold":{
                    "indicator":"Rsi","period":ji(10,18),"operator":rsi_op,"value":rsi_val
                }}},
                {"Leaf": {"Type":"IndicatorComparison","indicatorComparison":{
                    "leftIndicator":"Ema","leftPeriod":ji(40,60),
                    "rightIndicator":"Ema","rightPeriod":ji(180,220),
                    "operator":ema_op
                }}}
            ]
        },
        "StopLossAtrMultiplier": jr(1.5, 2.5),
        "TakeProfitAtrMultiplier": jr(2.0, 3.5),
        "AtrPeriod": random.choice([10, 14, 20]),
        "BaseConfidence": jr(0.5, 0.7),
    }
    print(json.dumps(rule))
else:
    sys.exit("unknown StrategyType: " + T)
PY
}

for ENTRY in "${SELECTED[@]}"; do
  TYPE="${ENTRY%%:*}"
  REST="${ENTRY#*:}"
  SYM="${REST%%:*}"
  REST2="${REST#*:}"
  TF="${REST2%%:*}"
  RB_KIND=""
  if [[ "$REST2" == *":"* ]]; then
    RB_KIND="${REST2#*:}"
  fi

  PARAMS=$(gen_params "$TYPE" "$SYM" "$TF" "$RB_KIND")
  if [[ -z "$PARAMS" ]]; then
    log "  PARAM GEN FAILED for $ENTRY"
    continue
  fi

  STAMP=$(date +%H%M%S)
  RAND=$((RANDOM % 1000))
  NAME="Hunt $SYM $TF $TYPE ${RB_KIND:+$RB_KIND }$STAMP-$RAND"

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
  bt_days=$(days_for_backtest_tf "$TF")
  FROM_ISO=$(date -u -v-${bt_days}d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "${bt_days} days ago" +%Y-%m-%dT%H:%M:%SZ)
  BT=$(curl -s -X POST "$ENGINE_URL/api/v1/lascodia-trading-engine/backtest" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"strategyId\":$SID,\"symbol\":\"$SYM\",\"timeframe\":\"$TF\",\"fromDate\":\"$FROM_ISO\",\"toDate\":\"$TO_ISO\",\"initialBalance\":10000}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data','') if d.get('status') else '')")
  RID=$(curl -s -X POST "$ENGINE_URL/api/v1/lascodia-trading-engine/strategy-feedback/optimization/trigger" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"strategyId\":$SID,\"triggerType\":\"Manual\"}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data','') if d.get('status') else '')")
  log "  sid=$SID bt=$BT (${bt_days}d) rid=$RID '$NAME'"
done

log "batch done"

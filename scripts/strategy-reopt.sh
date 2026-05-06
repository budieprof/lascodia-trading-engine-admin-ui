#!/usr/bin/env bash
# strategy-reopt.sh — one batch of bulk re-optimization against existing strategies
# Independent of Claude Code. Picks up to 3 stale-or-never-optimized strategies that
# aren't already in flight, queues a Manual optimization for each, and (if no recent
# Completed BacktestRun exists) also queues a Manual backtest that auto-chains a
# WalkForwardRun. Skips the EURUSD H1 MovingAverageCrossover dead-end per memory.

set -euo pipefail

ENGINE_URL="${ENGINE_URL:-http://localhost:5081}"
PG_CONTAINER="${PG_CONTAINER:-lascodia-trading-engine-postgres-1}"
PG_DB="${PG_DB:-LascodiaTradingEngineDb}"
PG_USER="${PG_USER:-postgres}"
LOG="${REOPT_LOG:-/tmp/strategy-reopt-loop.log}"

ts() { date +%Y-%m-%dT%H:%M:%S; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

if ! curl -sf -o /dev/null "$ENGINE_URL/health"; then
  log "engine not reachable, skipping batch"
  exit 0
fi

TOKEN=$(curl -s -X POST "$ENGINE_URL/api/v1/lascodia-trading-engine/auth/token" \
  -H "Content-Type: application/json" \
  -d '{"userId":"strategy-reopt-loop","firstName":"Reopt","lastName":"Loop","email":"reopt-loop@dev.local","roles":["Operator","Analyst"]}' \
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

# Pick 3 strategies: stale (>14 days since last opt) OR never optimized.
# Exclude: pruned/decommissioned, CompositeML, Custom (perf fixtures), in-flight,
# and the EURUSD H1 MovingAverageCrossover dead-end (43 fails / 0 wins per memory).
TARGETS=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "
WITH last_runs AS (
  SELECT DISTINCT ON (r.\"StrategyId\") r.\"StrategyId\", r.\"QueuedAt\"
  FROM \"OptimizationRun\" r WHERE NOT r.\"IsDeleted\"
  ORDER BY r.\"StrategyId\", r.\"QueuedAt\" DESC
),
in_flight AS (
  SELECT DISTINCT \"StrategyId\" FROM \"OptimizationRun\"
  WHERE \"Status\" IN ('Queued','Running','Claimed') AND NOT \"IsDeleted\"
)
SELECT s.\"Id\"||':'||s.\"Symbol\"||':'||s.\"Timeframe\"
FROM \"Strategy\" s LEFT JOIN last_runs lr ON lr.\"StrategyId\" = s.\"Id\"
WHERE NOT s.\"IsDeleted\"
  AND s.\"Id\" NOT IN (SELECT \"StrategyId\" FROM in_flight)
  AND s.\"LifecycleStage\" NOT IN ('Pruned','Decommissioned')
  AND s.\"StrategyType\" NOT IN ('CompositeML','Custom')
  AND NOT (s.\"Symbol\"='EURUSD' AND s.\"Timeframe\"='H1' AND s.\"StrategyType\"='MovingAverageCrossover')
  AND (lr.\"QueuedAt\" IS NULL OR lr.\"QueuedAt\" < NOW() - INTERVAL '14 days')
ORDER BY (lr.\"QueuedAt\" IS NULL) DESC, lr.\"QueuedAt\" ASC NULLS FIRST, s.\"Id\"
LIMIT 3;")

if [[ -z "$TARGETS" ]]; then
  log "no stale/unoptimized targets, skipping batch"
  exit 0
fi

TO_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Timeframe-aware backtest window — see scripts/strategy-hunt.sh for the rationale.
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

COUNT=$(echo "$TARGETS" | grep -c .)
log "batch start — re-optimizing $COUNT strategies (in-flight=$INFLIGHT)"

while IFS=: read -r SID SYM TF; do
  [[ -z "$SID" ]] && continue
  RID=$(curl -s -X POST "$ENGINE_URL/api/v1/lascodia-trading-engine/strategy-feedback/optimization/trigger" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"strategyId\":$SID,\"triggerType\":\"Manual\"}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data','') if d.get('status') else '')")
  if [[ -z "$RID" ]]; then
    log "  TRIGGER FAILED sid=$SID"
    continue
  fi

  RECENT_BT=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
    "SELECT EXISTS(SELECT 1 FROM \"BacktestRun\" WHERE \"StrategyId\" = $SID AND \"Status\" = 'Completed' AND \"CompletedAt\" > NOW() - INTERVAL '7 days');")
  BT=""
  bt_days=$(days_for_backtest_tf "$TF")
  if [[ "$RECENT_BT" != "t" ]]; then
    FROM_ISO=$(date -u -v-${bt_days}d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "${bt_days} days ago" +%Y-%m-%dT%H:%M:%SZ)
    BT=$(curl -s -X POST "$ENGINE_URL/api/v1/lascodia-trading-engine/backtest" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "{\"strategyId\":$SID,\"symbol\":\"$SYM\",\"timeframe\":\"$TF\",\"fromDate\":\"$FROM_ISO\",\"toDate\":\"$TO_ISO\",\"initialBalance\":10000}" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data','') if d.get('status') else '')")
  fi
  log "  sid=$SID $SYM $TF rid=$RID${BT:+ bt=$BT (${bt_days}d)}${BT:- bt=cached}"
done <<<"$TARGETS"

log "batch done"

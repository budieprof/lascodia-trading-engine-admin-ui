#!/usr/bin/env bash
# ml-train.sh — one batch of ML model training discovery against the local Lascodia engine
# Independent of Claude Code. Finds (Symbol, Timeframe) pairs whose Strategy rows have
# LifecycleStage='PendingModel' and no in-flight MLTrainingRun, queues training for up to 2,
# using timeframe-aware date windows to clear the 1500-sample minimum gate.

set -euo pipefail

ENGINE_URL="${ENGINE_URL:-http://localhost:5081}"
PG_CONTAINER="${PG_CONTAINER:-lascodia-trading-engine-postgres-1}"
PG_DB="${PG_DB:-LascodiaTradingEngineDb}"
PG_USER="${PG_USER:-postgres}"
LOG="${ML_LOG:-/tmp/ml-train-loop.log}"

ts() { date +%Y-%m-%dT%H:%M:%S; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

if ! curl -sf -o /dev/null "$ENGINE_URL/health"; then
  log "engine not reachable, skipping batch"
  exit 0
fi

TOKEN=$(curl -s -X POST "$ENGINE_URL/api/v1/lascodia-trading-engine/auth/token" \
  -H "Content-Type: application/json" \
  -d '{"userId":"ml-train-loop","firstName":"ML","lastName":"Loop","email":"ml-loop@dev.local","roles":["Operator","Analyst"]}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

if [[ -z "$TOKEN" ]]; then
  log "failed to acquire token, skipping batch"
  exit 0
fi

# Find PendingModel pairs not currently in flight
TARGETS=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "
WITH in_flight AS (
  SELECT DISTINCT \"Symbol\", \"Timeframe\" FROM \"MLTrainingRun\"
  WHERE \"Status\" IN ('Queued','Running')
)
SELECT s.\"Symbol\"||':'||s.\"Timeframe\"
FROM \"Strategy\" s
WHERE s.\"LifecycleStage\" = 'PendingModel' AND NOT s.\"IsDeleted\"
  AND (s.\"Symbol\", s.\"Timeframe\") NOT IN (SELECT \"Symbol\", \"Timeframe\" FROM in_flight)
GROUP BY s.\"Symbol\", s.\"Timeframe\"
ORDER BY COUNT(*) DESC, s.\"Symbol\", s.\"Timeframe\"
LIMIT 2;")

if [[ -z "$TARGETS" ]]; then
  log "no PendingModel pairs to train, skipping batch"
  exit 0
fi

# Per-timeframe lookback (days) sized to clear the 1500-sample minimum gate
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
COUNT=$(echo "$TARGETS" | grep -c .)
log "batch start — queuing $COUNT training runs"

while IFS=: read -r SYM TF; do
  [[ -z "$SYM" ]] && continue
  days=$(days_for_tf "$TF")
  FROM_DATE=$(date -u -v-${days}d +%Y-%m-%d 2>/dev/null || date -u -d "${days} days ago" +%Y-%m-%d)
  RESP=$(curl -s -X POST "$ENGINE_URL/api/v1/lascodia-trading-engine/ml-model/training/trigger" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"symbol\":\"$SYM\",\"timeframe\":\"$TF\",\"fromDate\":\"$FROM_DATE\",\"toDate\":\"$TO_DATE\",\"triggerType\":\"Manual\",\"learnerArchitecture\":0}")
  RID=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data','') if d.get('status') else '')")
  if [[ -z "$RID" ]]; then
    log "  TRIGGER FAILED $SYM $TF: $RESP"
  else
    log "  $SYM $TF runId=$RID window=${days}d"
  fi
done <<<"$TARGETS"

log "batch done"

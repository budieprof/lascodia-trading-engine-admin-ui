import type { EAConfigInputs, UpdateInstanceConfigRequest } from '@core/api/api.types';

/**
 * The EA settings the config panel edits, in operator words.
 *
 * `help` is the one line shown under each setting. `takesEffect` is the
 * technical note (EA class / phase that reads it), kept for the ⓘ tooltip.
 */

export type HotReloadKey =
  | 'tickThrottleMs'
  | 'signalPollSec'
  | 'positionSyncSec'
  | 'accountSyncSec'
  | 'heartbeatSec'
  | 'commandPollSec'
  | 'entryToleranceBandPct'
  | 'entryToleranceTpFrac'
  | 'entryToleranceMaxSignalAgeSec'
  | 'maxSlippageSlFrac'
  | 'maxSpreadSlFrac'
  | 'maxSlippagePoints'
  | 'maxOrderRetries'
  | 'httpTimeoutData'
  | 'httpTimeoutOrder'
  | 'maxNotionalExposurePct'
  | 'maxPeakDrawdownPct'
  | 'flashCrashPct'
  | 'engineTimeoutSec'
  | 'dailyProfitTargetAbs'
  | 'dailyProfitTargetPct'
  | 'engineFailThreshold'
  | 'unmatchedDealExpirySec'
  | 'safeModeTimeoutSec'
  | 'backfillBars'
  | 'backfillChunkSize'
  | 'specRefreshHour'
  | 'tickBufferMax'
  | 'engineBaseUrl'
  | 'logLevel'
  | 'enableFileLogging'
  | 'enableChartPanel'
  | 'enableChartMarkers'
  | 'symbols'
  | 'maxPosPerSymbol'
  | 'maxLotPerOrder'
  | 'maxSpreadPoints'
  | 'maxConsecLosses'
  | 'consecLossPauseMin'
  | 'maxDailyLossPerSymbolPct'
  | 'maxOpenPositions'
  | 'maxDailyLossPct'
  | 'maxOrdersPerMin'
  | 'maxTotalLots';

export type FieldKind = 'int' | 'double' | 'string' | 'url' | 'bool' | 'enum' | 'symbols';

/** `live` = next read cycle; `next-job` = new backfill jobs; `restart` = only after the EA restarts. */
export type ReloadBadge = 'live' | 'next-job' | 'restart';

export interface FieldDef {
  key: HotReloadKey;
  label: string;
  help: string;
  kind: FieldKind;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  /** Shown beside the input when the value is 0 (e.g. "Off"). */
  zeroMeans?: string;
  /**
   * Batch 8: the engine never forwards a 0 for this setting (0 / omitted = keep current), so 0 is refused as an
   * edit instead of being "pushed" as a silent no-op. Set on the ten circuit-breaker limits.
   */
  zeroKeepsCurrent?: boolean;
  /** Shown beside the EA's CURRENT value when it is 0 (never beside an edit) — e.g. a gate the EA reports as off. */
  currentZeroMeans?: string;
  options?: readonly string[];
  badge: ReloadBadge;
  takesEffect: string;
}

export interface FieldGroup {
  title: string;
  blurb: string;
  fields: readonly FieldDef[];
}

export const BADGE_WORDS: Record<ReloadBadge, { label: string; title: string }> = {
  live: { label: 'Instant', title: 'Applies within a few seconds — no restart.' },
  'next-job': { label: 'Next backfill', title: 'Used by backfill jobs created after the change.' },
  restart: {
    label: 'After restart',
    title:
      'Saved now, but the EA only reads it when it starts. Use the "Restart settings" tab to change it and restart in one step.',
  },
};

export const HOT_RELOAD_GROUPS: readonly FieldGroup[] = [
  {
    title: 'Symbols',
    blurb: 'Which instruments this EA streams prices for and trades.',
    fields: [
      {
        key: 'symbols',
        label: 'Owned symbols',
        help: 'Pick from the engine’s instruments. A symbol owned by another EA on the same account cannot be added, and a symbol with open positions cannot be removed.',
        kind: 'symbols',
        badge: 'live',
        takesEffect:
          'CInstanceManager.TryUpdateOwnedSymbols — releases removed symbols and claims added ones via SymbolOwnership CAS. Refused when a removed symbol still has open positions. Empty / CHART / ALL are init-only modes.',
      },
    ],
  },
  {
    title: 'Connection',
    blurb: 'Where the EA finds the engine.',
    fields: [
      {
        key: 'engineBaseUrl',
        label: 'Engine address',
        help: 'The EA tests the new address before switching and keeps the old one if the test fails. Public addresses must use https://, and the address must be in MT5’s WebRequest allowed list.',
        kind: 'url',
        badge: 'live',
        takesEffect:
          'Probe-gated: GET /health/live at the candidate host before switching. http:// only for localhost / RFC1918. Excluded from config profiles. Falls back to the compiled-in input URL on restart if the override stops resolving.',
      },
    ],
  },
  {
    title: 'Safety — this EA',
    blurb: 'Limits checked before every order this EA sends.',
    fields: [
      {
        key: 'maxPosPerSymbol',
        label: 'Max positions per symbol',
        help: 'New entries on a symbol are blocked once it has this many open positions.',
        kind: 'int',
        unit: 'positions',
        step: 1,
        min: 0,
        zeroKeepsCurrent: true,
        badge: 'live',
        takesEffect: 'CCircuitBreaker.HotReload — next safety check.',
      },
      {
        key: 'maxLotPerOrder',
        label: 'Max lot size per order',
        help: 'Orders above this size are rejected.',
        kind: 'double',
        unit: 'lots',
        step: 0.01,
        min: 0,
        zeroKeepsCurrent: true,
        badge: 'live',
        takesEffect:
          'CCircuitBreaker.HotReload + COrderExecutor.SetMaxLotPerOrder — next OrderSend.',
      },
      {
        key: 'maxSpreadPoints',
        label: 'Max spread',
        help: 'No new orders while the spread is wider than this.',
        kind: 'int',
        unit: 'points',
        step: 1,
        min: 0,
        zeroKeepsCurrent: true,
        badge: 'live',
        takesEffect: 'CCircuitBreaker.HotReload — next pre-send check.',
      },
      {
        key: 'maxConsecLosses',
        label: 'Losing streak before a pause',
        help: 'After this many losses in a row on a symbol, the EA pauses new entries on it.',
        kind: 'int',
        unit: 'losses',
        step: 1,
        min: 0,
        zeroKeepsCurrent: true,
        badge: 'live',
        takesEffect: 'CCircuitBreaker.HotReload — next loss tally.',
      },
      {
        key: 'consecLossPauseMin',
        label: 'Pause length after a losing streak',
        help: 'How long the symbol stays paused.',
        kind: 'int',
        unit: 'min',
        step: 5,
        min: 0,
        zeroKeepsCurrent: true,
        badge: 'live',
        takesEffect: 'CCircuitBreaker.HotReload — applies when the pause is next armed.',
      },
      {
        key: 'maxDailyLossPerSymbolPct',
        label: 'Max daily loss per symbol',
        help: 'Stops new entries on a symbol once its loss today reaches this share of equity. Blank or 0 keeps the current value — to remove the limit use “Switch off the gate”.',
        kind: 'double',
        unit: '% equity',
        step: 0.1,
        min: 0,
        currentZeroMeans: 'Off — gate switched off',
        zeroKeepsCurrent: true,
        badge: 'live',
        takesEffect: 'CCircuitBreaker.HotReload — next daily-PnL check.',
      },
    ],
  },
  {
    title: 'Safety — whole account',
    blurb: 'Limits shared by every EA on this terminal.',
    fields: [
      {
        key: 'maxOpenPositions',
        label: 'Max open positions',
        help: 'Across all symbols. New entries are blocked at this count.',
        kind: 'int',
        unit: 'positions',
        step: 1,
        min: 0,
        zeroKeepsCurrent: true,
        badge: 'live',
        takesEffect: 'CGlobalCircuitBreaker.HotReload — next position-count check.',
      },
      {
        key: 'maxTotalLots',
        label: 'Max total open lots',
        help: 'The sum of all open position sizes.',
        kind: 'double',
        unit: 'lots',
        step: 0.1,
        min: 0,
        zeroKeepsCurrent: true,
        badge: 'live',
        takesEffect: 'CGlobalCircuitBreaker.HotReload — next position-open check.',
      },
      {
        key: 'maxDailyLossPct',
        label: 'Max daily loss',
        help: 'Trading stops for the day once today’s loss reaches this share of equity.',
        kind: 'double',
        unit: '% equity',
        step: 0.1,
        min: 0,
        zeroKeepsCurrent: true,
        badge: 'live',
        takesEffect: 'CGlobalCircuitBreaker.HotReload — next equity check.',
      },
      {
        key: 'maxOrdersPerMin',
        label: 'Max orders per minute',
        help: 'A rate limit that stops runaway order loops.',
        kind: 'int',
        unit: 'orders/min',
        step: 1,
        min: 0,
        zeroKeepsCurrent: true,
        badge: 'live',
        takesEffect: 'CGlobalCircuitBreaker.HotReload — next rate-limit window.',
      },
    ],
  },
  {
    title: 'Risk guards',
    blurb: 'Account-level brakes and the daily profit target.',
    fields: [
      {
        key: 'maxNotionalExposurePct',
        label: 'Max total exposure',
        help: 'The total size of open positions, as a share of equity.',
        kind: 'double',
        unit: '% equity',
        step: 1,
        min: 0,
        badge: 'live',
        takesEffect: 'CGlobalCircuitBreaker.SetMaxNotionalExposurePct — next exposure check.',
      },
      {
        key: 'maxPeakDrawdownPct',
        label: 'Max drawdown from peak',
        help: 'Stops trading when equity falls this far below its highest point.',
        kind: 'double',
        unit: '%',
        step: 0.1,
        min: 0,
        badge: 'live',
        takesEffect: 'CGlobalCircuitBreaker.SetMaxPeakDrawdownPct — next drawdown check.',
      },
      {
        key: 'flashCrashPct',
        label: 'Flash-crash trigger',
        help: 'A price move this large in a short window halts new entries.',
        kind: 'double',
        unit: '%',
        step: 0.1,
        min: 0,
        badge: 'live',
        takesEffect:
          'CGlobalCircuitBreaker.SetFlashCrashPct — the rolling window resets on each update.',
      },
      {
        key: 'dailyProfitTargetAbs',
        label: 'Daily profit target ($)',
        help: 'When today’s profit (closed + open) reaches this, the EA cancels pending orders, closes positions, and stops until the next trading day.',
        kind: 'double',
        unit: '$',
        step: 1,
        min: 0,
        zeroMeans: 'Off',
        badge: 'live',
        takesEffect: 'Per-instance. The % target wins when both are set.',
      },
      {
        key: 'dailyProfitTargetPct',
        label: 'Daily profit target (%)',
        help: 'The same target as a share of start-of-day equity. Used instead of the $ target when both are set.',
        kind: 'double',
        unit: '% equity',
        step: 0.1,
        min: 0,
        zeroMeans: 'Off',
        badge: 'live',
        takesEffect: 'Per-instance. Takes precedence over the $ target.',
      },
      {
        key: 'engineTimeoutSec',
        label: 'Engine silence before safe mode',
        help: 'If the engine does not answer for this long, the EA stops opening trades (safe mode).',
        kind: 'int',
        unit: 's',
        step: 5,
        min: 5,
        badge: 'live',
        takesEffect:
          'CConnectionMonitor.SetEngineTimeoutSec + CGlobalCircuitBreaker.SetEngineTimeoutSec. Floored at 5 s.',
      },
      {
        key: 'engineFailThreshold',
        label: 'Failed calls before safe mode',
        help: 'How many engine calls in a row may fail before the EA enters safe mode.',
        kind: 'int',
        unit: 'calls',
        step: 1,
        min: 1,
        badge: 'live',
        takesEffect: 'CConnectionMonitor.SetEngineFailThreshold — next failure check.',
      },
      {
        key: 'safeModeTimeoutSec',
        label: 'Safe mode before safety stop',
        help: 'If safe mode lasts this long, the EA escalates to a safety stop.',
        kind: 'int',
        unit: 's',
        step: 30,
        min: 0,
        badge: 'live',
        takesEffect: 'Read every cycle in EAEngineHealthAndCoordinationPhases.',
      },
      {
        key: 'unmatchedDealExpirySec',
        label: 'Forget unmatched deals after',
        help: 'How long a broker deal with no matching order is kept while the EA waits for its order.',
        kind: 'int',
        unit: 's',
        step: 30,
        min: 0,
        badge: 'restart',
        takesEffect: 'Cached on TradeTransactionHandler at OnInit.',
      },
    ],
  },
  {
    title: 'Order execution',
    blurb: 'How strict the EA is when it sends an order.',
    fields: [
      {
        key: 'maxSlippageSlFrac',
        label: 'Max slippage (share of stop distance)',
        help: 'For example, 0.1 allows the fill to be 10% of the stop distance away from the requested price.',
        kind: 'double',
        unit: '× SL',
        step: 0.01,
        min: 0,
        zeroMeans: 'Use points below',
        badge: 'live',
        takesEffect: 'Next OrderSend — request.deviation scales with the signal’s SL distance.',
      },
      {
        key: 'maxSlippagePoints',
        label: 'Max slippage (points)',
        help: 'Fixed fallback, used only when the setting above is 0.',
        kind: 'int',
        unit: 'points',
        step: 1,
        min: 0,
        badge: 'live',
        takesEffect: 'COrderExecutor.SetMaxSlippagePoints — next OrderSend.',
      },
      {
        key: 'maxSpreadSlFrac',
        label: 'Max spread (share of stop distance)',
        help: 'Skips the order when the spread is wider than this share of the stop distance.',
        kind: 'double',
        unit: '× SL',
        step: 0.01,
        min: 0,
        zeroMeans: 'Use points limit',
        badge: 'live',
        takesEffect: 'Next signal validation + execution-time spread re-check.',
      },
      {
        key: 'maxOrderRetries',
        label: 'Order retries',
        help: 'How many times a rejected order is retried.',
        kind: 'int',
        unit: 'retries',
        step: 1,
        min: 0,
        badge: 'live',
        takesEffect: 'COrderExecutor.SetMaxRetries — next retry loop.',
      },
      {
        key: 'httpTimeoutData',
        label: 'Engine request timeout (data)',
        help: 'How long the EA waits for the engine on data calls.',
        kind: 'int',
        unit: 'ms',
        step: 500,
        min: 0,
        badge: 'live',
        takesEffect:
          'CHttpClient.SetDefaultDataTimeoutMs — next request without an explicit timeout.',
      },
      {
        key: 'httpTimeoutOrder',
        label: 'Engine request timeout (orders)',
        help: 'How long the EA waits for the engine on order calls.',
        kind: 'int',
        unit: 'ms',
        step: 500,
        min: 0,
        badge: 'live',
        takesEffect: 'Shadow available for code that opts in.',
      },
    ],
  },
  {
    title: 'Market fill',
    blurb: 'When a signal fills at market instead of waiting as a pending order.',
    fields: [
      {
        key: 'entryToleranceTpFrac',
        label: 'Market-fill band (share of target distance)',
        help: 'If price is within this share of the entry→target distance, the EA fills at market instead of placing a pending order.',
        kind: 'double',
        unit: '× TP',
        step: 0.01,
        min: 0,
        zeroMeans: 'Use price band',
        badge: 'live',
        takesEffect: 'Next signal ClassifyExecutionType.',
      },
      {
        key: 'entryToleranceBandPct',
        label: 'Market-fill band (share of price)',
        help: 'Older fallback, used only when the setting above is 0. For example, 0.0005 = 0.05% of price.',
        kind: 'double',
        unit: '× price',
        step: 0.0001,
        min: 0,
        badge: 'live',
        takesEffect:
          'Next signal ClassifyExecutionType. Fallback when entryToleranceTpFrac = 0 or TP missing.',
      },
      {
        key: 'entryToleranceMaxSignalAgeSec',
        label: 'Market-fill only for signals younger than',
        help: 'Older signals always use a pending order.',
        kind: 'int',
        unit: 's',
        step: 5,
        min: 0,
        badge: 'live',
        takesEffect: 'Next signal ClassifyExecutionType.',
      },
    ],
  },
  {
    title: 'Timing',
    blurb: 'How often the EA talks to the engine. Lower = faster but more load.',
    fields: [
      {
        key: 'signalPollSec',
        label: 'Check for new signals every',
        help: 'How quickly approved signals reach the broker.',
        kind: 'int',
        unit: 's',
        step: 1,
        min: 1,
        badge: 'live',
        takesEffect: 'Next Phase-6 cycle.',
      },
      {
        key: 'commandPollSec',
        label: 'Check for commands every',
        help: 'How quickly operator commands (restart, close, …) are picked up.',
        kind: 'int',
        unit: 's',
        step: 1,
        min: 1,
        badge: 'live',
        takesEffect: 'Next Phase-6 cycle.',
      },
      {
        key: 'heartbeatSec',
        label: 'Heartbeat every',
        help: 'How often the EA reports it is alive. At least 5 s.',
        kind: 'int',
        unit: 's',
        step: 1,
        min: 5,
        badge: 'live',
        takesEffect: 'CHeartbeat.SetIntervalSec — next heartbeat cycle.',
      },
      {
        key: 'positionSyncSec',
        label: 'Sync positions every',
        help: 'How often open positions are reconciled with the engine.',
        kind: 'int',
        unit: 's',
        step: 1,
        min: 1,
        badge: 'live',
        takesEffect: 'Next Phase-7 cycle.',
      },
      {
        key: 'accountSyncSec',
        label: 'Sync account every',
        help: 'How often balance, equity and margin are sent.',
        kind: 'int',
        unit: 's',
        step: 1,
        min: 1,
        badge: 'live',
        takesEffect: 'Next Phase-7 cycle.',
      },
      {
        key: 'tickThrottleMs',
        label: 'Minimum gap between price ticks',
        help: 'Ticks closer together than this are merged before they are sent.',
        kind: 'int',
        unit: 'ms',
        step: 10,
        min: 0,
        badge: 'live',
        takesEffect: 'Next AutotuneThrottle cycle.',
      },
    ],
  },
  {
    title: 'Price history',
    blurb: 'How much candle history the EA uploads.',
    fields: [
      {
        key: 'backfillBars',
        label: 'History to upload',
        help: 'Per symbol and timeframe.',
        kind: 'int',
        unit: 'bars',
        step: 100,
        min: 0,
        badge: 'next-job',
        takesEffect: 'Read at backfill-job creation.',
      },
      {
        key: 'backfillChunkSize',
        label: 'Upload batch size',
        help: 'Bars sent per request during a backfill.',
        kind: 'int',
        unit: 'bars',
        step: 100,
        min: 1,
        badge: 'next-job',
        takesEffect: 'Read at backfill-chunk creation.',
      },
      {
        key: 'specRefreshHour',
        label: 'Daily symbol-spec refresh at',
        help: 'The hour, in the broker’s server time, when contract specs are re-sent.',
        kind: 'int',
        unit: 'h (0–23)',
        step: 1,
        min: 0,
        max: 23,
        badge: 'live',
        takesEffect: 'BackfillCursor reads the shadow on each scheduler check.',
      },
      {
        key: 'tickBufferMax',
        label: 'Tick buffer size',
        help: 'Ticks held in memory while the engine is unreachable.',
        kind: 'int',
        unit: 'ticks',
        step: 100,
        min: 0,
        badge: 'restart',
        takesEffect: 'Cached on the tick buffer at OnInit.',
      },
    ],
  },
  {
    title: 'Logs & chart',
    blurb: 'What the EA writes and shows on its chart.',
    fields: [
      {
        key: 'logLevel',
        label: 'Log detail',
        help: 'DEBUG is the most detailed; ERROR logs only failures.',
        kind: 'enum',
        options: ['DEBUG', 'INFO', 'WARN', 'ERROR'],
        badge: 'live',
        takesEffect: 'CLogger.SetLevel — propagates to the file sink.',
      },
      {
        key: 'enableFileLogging',
        label: 'Write logs to file',
        help: 'Daily log files under MQL5/Files/Lascodia.',
        kind: 'bool',
        badge: 'restart',
        takesEffect: 'File logger init cached at OnInit.',
      },
      {
        key: 'enableChartPanel',
        label: 'Status panel on chart',
        help: 'The EA’s dashboard drawn on its MT5 chart.',
        kind: 'bool',
        badge: 'restart',
        takesEffect: 'Chart panel init cached at OnInit.',
      },
      {
        key: 'enableChartMarkers',
        label: 'Trade markers on chart',
        help: 'Arrows for entries and exits on the MT5 chart.',
        kind: 'bool',
        badge: 'live',
        takesEffect: 'OperationalHelpers reads the shadow before each marker.',
      },
    ],
  },
];

export const HOT_RELOAD_FIELDS: readonly FieldDef[] = HOT_RELOAD_GROUPS.flatMap((g) => g.fields);

/** MT5 timeframes the EA can monitor, in display order. */
export const MT5_TIMEFRAMES: readonly string[] = [
  'M1',
  'M5',
  'M15',
  'M30',
  'H1',
  'H4',
  'D1',
  'W1',
  'MN1',
];

/** Plain words for the restart-only inputs (keyed by envelope key). */
export const RESTART_HELP: Record<string, string> = {
  engineBaseUrl: 'The address the EA uses when it starts.',
  symbolMapping:
    'Only needed when the broker’s symbol names differ from the engine’s (for example EURUSDm → EURUSD).',
  timeframes: 'Candle timeframes the EA streams for every owned symbol.',
  instanceLabel: 'A friendly name for this EA. Blank = the chart symbol.',
  magicNumber: 'Tags this EA’s orders at the broker. 0 = pick one automatically.',
  useAsyncOrders: 'Send orders without waiting for the broker’s reply. Recommended.',
  useDllTransport: 'Use the faster socket bridge instead of WebRequest.',
  dllBridgeHost: 'Blank = use the address the engine advertises.',
  dllBridgePort: '0 = use the port the engine advertises.',
  dllBridgeUseTls: 'Must match the engine’s bridge setting.',
  dllBridgeStrictTls: 'Reject bridge certificates that do not validate.',
  dllBridgeCertFingerprint: 'Pin the bridge certificate (SHA-256). Blank = no pin.',
  coordinatorStaleSec:
    'How long before another EA takes over coordinator duties from a silent one.',
  casEscalateThreshold: 'Shared-state write conflicts tolerated before a safety stop.',
  unmatchedDealExpirySec: 'How long a broker deal with no matching order is kept.',
  tickBufferMax: 'Ticks held in memory while the engine is unreachable.',
  enableFileLogging: 'Daily log files under MQL5/Files/Lascodia.',
  enableChartPanel: 'The EA’s dashboard drawn on its MT5 chart.',
};

/** Units for restart-only numeric inputs. */
export const RESTART_UNITS: Record<string, string> = {
  coordinatorStaleSec: 's',
  casEscalateThreshold: 'conflicts',
  unmatchedDealExpirySec: 's',
  tickBufferMax: 'ticks',
};

// ── Pure helpers (table-tested in ea-config-fields.spec.ts) ───────────────

/** Edits as the panel holds them: raw typed strings for numbers/text, booleans for switches, a CSV for symbols. */
export type ConfigEdits = Partial<Record<HotReloadKey, string | boolean>>;

/**
 * The POST /admin/ea/{id}/config body for the given edited settings — ONLY those keys, never a default or a blank
 * (the engine forwards every field it receives to the EA). Returns null when nothing is left to send, so the caller
 * sends no request at all. A 0 on a `zeroKeepsCurrent` limit is dropped defensively (validation already refuses it):
 * it would be a no-op, and it is never the way to switch a gate off — see `buildDisableDailyLossPerSymbolBody`.
 */
export function buildConfigBody(
  instanceId: string,
  fields: readonly FieldDef[],
  edits: ConfigEdits,
): UpdateInstanceConfigRequest | null {
  const body: Record<string, number | string | boolean> = {};
  for (const f of fields) {
    const raw = edits[f.key];
    if (raw === undefined) continue;
    if (f.kind === 'bool') {
      if (typeof raw === 'boolean') body[f.key] = raw;
      continue;
    }
    const text = String(raw).trim();
    if (text === '') continue;
    if (f.kind === 'symbols') {
      const list = parseSymbolCsv(text);
      if (list.length > 0) body[f.key] = list.join(',');
    } else if (f.kind === 'int' || f.kind === 'double') {
      const n = Number(text);
      if (!Number.isFinite(n)) continue;
      if (f.zeroKeepsCurrent && n <= 0) continue;
      body[f.key] = n;
    } else {
      body[f.key] = text;
    }
  }
  if (Object.keys(body).length === 0) return null;
  // The server DTO marks `instanceId` required, so it is echoed in the body too.
  return { instanceId, ...body } as UpdateInstanceConfigRequest;
}

/**
 * The only request that switches the EA's per-symbol daily-loss gate off. A bare 0 keeps the current value (engine
 * batch 8) and EA ≥ 8.47.287 refuses one, so the intent travels as an explicit flag and nothing else rides along.
 */
export function buildDisableDailyLossPerSymbolBody(
  instanceId: string,
): UpdateInstanceConfigRequest {
  return { instanceId, disableMaxDailyLossPerSymbol: true };
}

// ── Tick gap fill (batch 8 runtime override of InpMdGapFill*) ─────────────

/** `inputs` = no override: the EA runs on its chart inputs. */
export type GapFillMode = 'on' | 'off' | 'inputs';

export interface GapFillState {
  /** False when the EA build does not report `mdGapFillOverride` (before 8.47.287): it cannot take an override. */
  supported: boolean;
  mode: GapFillMode;
  /** Effective values (override or chart inputs). */
  enabled: boolean;
  remote: boolean;
  maxAgeHours: number | null;
  /** The filler is running right now (`mdGapFillActive`); null = not reported. */
  active: boolean | null;
}

export interface GapFillEdit {
  mode?: GapFillMode;
  remote?: boolean;
  /** Raw typed text. */
  maxAgeHours?: string;
}

export const GAP_FILL_MAX_AGE_MIN = 1;
export const GAP_FILL_MAX_AGE_MAX = 168;

export function gapFillState(inputs: EAConfigInputs | null | undefined): GapFillState {
  const i = inputs ?? {};
  const supported = typeof i.mdGapFillOverride === 'boolean';
  const enabled = i.mdGapFill === true;
  return {
    supported,
    mode: i.mdGapFillOverride === true ? (enabled ? 'on' : 'off') : 'inputs',
    enabled,
    remote: i.mdGapFillRemote === true,
    maxAgeHours: typeof i.mdGapFillMaxAgeHours === 'number' ? i.mdGapFillMaxAgeHours : null,
    active: typeof i.mdGapFillActive === 'boolean' ? i.mdGapFillActive : null,
  };
}

/** Plain-language error for the max-age box, or null. */
export function validateGapFillMaxAge(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Enter a whole number of hours.';
  if (n < GAP_FILL_MAX_AGE_MIN || n > GAP_FILL_MAX_AGE_MAX)
    return `Between ${GAP_FILL_MAX_AGE_MIN} and ${GAP_FILL_MAX_AGE_MAX} hours.`;
  return null;
}

/**
 * The gap-fill part of a config push, or null when the edit changes nothing (or is invalid).
 *  - "Use chart inputs" while an override is in force → `{ mdGapFillOverride: 'clear' }` alone (the EA ignores the
 *    other fields beside a clear).
 *  - On / Off → `mdGapFill` when the mode changes (choosing the value the inputs already give still sends it: it pins
 *    that value as an override). Remote / max age only when they differ from the effective value; they are not sent
 *    while the EA stays on its chart inputs, because any one of them would start an override.
 */
export function buildGapFillPatch(
  state: GapFillState,
  edit: GapFillEdit,
): Pick<
  UpdateInstanceConfigRequest,
  'mdGapFill' | 'mdGapFillRemote' | 'mdGapFillMaxAgeHours' | 'mdGapFillOverride'
> | null {
  if (!state.supported) return null;
  const mode = edit.mode ?? state.mode;
  if (mode === 'inputs') return state.mode === 'inputs' ? null : { mdGapFillOverride: 'clear' };
  if (validateGapFillMaxAge(edit.maxAgeHours) !== null) return null;
  const patch: {
    mdGapFill?: boolean;
    mdGapFillRemote?: boolean;
    mdGapFillMaxAgeHours?: number;
  } = {};
  if (mode !== state.mode) patch.mdGapFill = mode === 'on';
  if (edit.remote !== undefined && edit.remote !== state.remote)
    patch.mdGapFillRemote = edit.remote;
  const age =
    edit.maxAgeHours !== undefined && edit.maxAgeHours.trim() !== ''
      ? Number(edit.maxAgeHours.trim())
      : undefined;
  if (age !== undefined && age !== state.maxAgeHours) patch.mdGapFillMaxAgeHours = age;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** "eurusd, GBPUSD,,eurusd" → ["EURUSD","GBPUSD"] — the EA's own parse (trim, upper, dedupe). */
export function parseSymbolCsv(csv: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of (csv ?? '').split(',')) {
    const s = raw.trim().toUpperCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function sameSymbolSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((s) => set.has(s));
}

/** Symbol names the EA accepts: letters, digits and . _ - # (broker suffixes). */
export function isValidSymbolName(s: string): boolean {
  return /^[A-Z0-9][A-Z0-9._#-]{1,31}$/.test(s);
}

/** "EURUSDm=EURUSD, XAUUSD.spot=XAUUSD" → rows. Rows without "=" keep the text as the broker side. */
export function parseSymbolMap(
  text: string | null | undefined,
): { broker: string; engine: string }[] {
  return (text ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0
        ? { broker: p, engine: '' }
        : {
            broker: p.slice(0, i).trim(),
            engine: p
              .slice(i + 1)
              .trim()
              .toUpperCase(),
          };
    });
}

/** Rows → "EURUSDm=EURUSD,XAUUSD.spot=XAUUSD"; incomplete rows are dropped. */
export function formatSymbolMap(rows: readonly { broker: string; engine: string }[]): string {
  return rows
    .map((r) => ({ broker: r.broker.trim(), engine: r.engine.trim().toUpperCase() }))
    .filter((r) => r.broker && r.engine)
    .map((r) => `${r.broker}=${r.engine}`)
    .join(',');
}

/** "h1, m5,BAD" → canonical "M5,H1" (unknown entries dropped, MT5 order). */
export function normalizeTimeframes(csv: string | null | undefined): string[] {
  const set = new Set(
    (csv ?? '')
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean),
  );
  return MT5_TIMEFRAMES.filter((t) => set.has(t));
}

/**
 * Plain-language error for a hot-reload edit, or null. `raw` is what the
 * operator typed (string for numbers/text, boolean, or a CSV for symbols).
 */
export function validateField(f: FieldDef, raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (f.kind === 'int' || f.kind === 'double') {
    const s = String(raw).trim();
    const n = Number(s);
    if (s === '' || !Number.isFinite(n)) return 'Enter a number.';
    if (f.kind === 'int' && !Number.isInteger(n)) return 'Enter a whole number.';
    if (f.zeroKeepsCurrent && n === 0)
      return f.key === 'maxDailyLossPerSymbolPct'
        ? '0 is not sent — it keeps the current value. To remove this limit, use “Switch off the gate”.'
        : '0 is not sent — it keeps the current value. Enter a positive limit.';
    if (f.min !== undefined && n < f.min) return `At least ${f.min}.`;
    if (f.max !== undefined && n > f.max) return `At most ${f.max}.`;
    return null;
  }
  if (f.kind === 'url') {
    const s = String(raw).trim();
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return 'Enter a full address, e.g. https://example.com/api/v1/…';
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Use http:// or https://.';
    if (f.key === 'engineBaseUrl' && u.protocol === 'http:' && !isPrivateHost(u.hostname))
      return 'Public addresses must use https://.';
    return null;
  }
  if (f.kind === 'symbols') {
    const list = parseSymbolCsv(String(raw));
    if (list.length === 0) return 'Keep at least one symbol.';
    const bad = list.find((s) => !isValidSymbolName(s));
    return bad ? `"${bad}" is not a valid symbol name.` : null;
  }
  if (f.kind === 'string') {
    const s = String(raw);
    if (/[\r\n]/.test(s)) return 'Line breaks are not allowed.';
    if (s.length > 512) return 'At most 512 characters.';
  }
  return null;
}

/** localhost or an RFC1918 address — the only hosts the EA accepts over plain http. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const a = +m[1];
  const b = +m[2];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

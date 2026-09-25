/**
 * The RuleBased / LlmProposal strategy DSL as the admin console sees it.
 *
 * This file is the single source of truth for the DSL vocabulary (condition
 * types, indicators, comparators, regimes, timeframes, indicator params) and
 * for moving between the JSON the engine stores and the tree the visual
 * builder edits. It mirrors `LlmStrategyProposalDsl.cs` in the engine.
 *
 * Casing. The engine reads the JSON case-insensitively, so a stored DSL can
 * come in any casing: LLM proposals write PascalCase everywhere, earlier
 * builds of this console wrote PascalCase structure with camelCase payloads,
 * operators paste whatever they have. Every key is therefore matched
 * case-insensitively on the way in, and the way out is always camelCase.
 *
 * Nothing is dropped. Keys this file does not know are carried through
 * verbatim, a node or condition whose shape it does not recognise is kept as
 * raw JSON, and a leaf is never replaced by an empty one — the builder that
 * used to do that wiped every LLM-written rule on its first visual edit.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** The engine's candle timeframes, lowest first. */
export const ENGINE_TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const;
export type EngineTimeframe = (typeof ENGINE_TIMEFRAMES)[number];

export const DIRECTIONS = ['Buy', 'Sell', 'Both'] as const;

export const LOGIC_OPS = ['And', 'Or', 'Not'] as const;

export interface ComparatorInfo {
  value: string;
  symbol: string;
  label: string;
}

export const COMPARATORS: readonly ComparatorInfo[] = [
  { value: 'LessThan', symbol: '<', label: 'less than' },
  { value: 'LessThanOrEqual', symbol: '≤', label: 'less than or equal to' },
  { value: 'GreaterThan', symbol: '>', label: 'greater than' },
  { value: 'GreaterThanOrEqual', symbol: '≥', label: 'greater than or equal to' },
  { value: 'Equal', symbol: '=', label: 'equal to' },
  { value: 'NotEqual', symbol: '≠', label: 'not equal to' },
];

export const MARKET_REGIMES = [
  'Trending',
  'Ranging',
  'HighVolatility',
  'LowVolatility',
  'Crisis',
  'Breakout',
] as const;

export const CANDLE_PATTERNS = [
  'Engulfing',
  'PinBar',
  'Doji',
  'InsideBar',
  'Hammer',
  'ShootingStar',
  'Harami',
  'MorningStar',
  'EveningStar',
] as const;

/** Threshold modes shared by `Spread` and `BarRange`. */
export const RANGE_MODES = ['Pips', 'AtrFraction'] as const;

/** Price source for the optional `params.source` of an indicator. */
export const PRICE_SOURCES = [
  'Close',
  'Open',
  'High',
  'Low',
  'Hl2',
  'Hlc3',
  'Ohlc4',
  'Hlcc4',
  'Volume',
] as const;

export type IndicatorParamKey =
  | 'fastPeriod'
  | 'slowPeriod'
  | 'signalPeriod'
  | 'multiplier'
  | 'smoothK'
  | 'smoothD'
  | 'longPeriod'
  | 'source';

export interface IndicatorParamInfo {
  key: IndicatorParamKey;
  label: string;
  kind: 'int' | 'decimal' | 'source';
}

export const INDICATOR_PARAMS: readonly IndicatorParamInfo[] = [
  { key: 'fastPeriod', label: 'fast period', kind: 'int' },
  { key: 'slowPeriod', label: 'slow period', kind: 'int' },
  { key: 'signalPeriod', label: 'signal period', kind: 'int' },
  { key: 'multiplier', label: 'std-dev multiplier', kind: 'decimal' },
  { key: 'smoothK', label: '%K smoothing', kind: 'int' },
  { key: 'smoothD', label: '%D smoothing', kind: 'int' },
  { key: 'longPeriod', label: 'long ATR period', kind: 'int' },
  { key: 'source', label: 'source', kind: 'source' },
];

export interface IndicatorInfo {
  kind: string;
  hint: string;
  /**
   * `oscillator` — bounded 0–100; `price` — a price level in the quote's own
   * units (always positive); `other` — unbounded or scale-dependent.
   */
  scale: 'oscillator' | 'price' | 'other';
  /** The optional `params` that change this indicator's value. */
  params: readonly IndicatorParamKey[];
}

const MACD_PARAMS: readonly IndicatorParamKey[] = ['fastPeriod', 'slowPeriod', 'source'];
const MACD_SIGNAL_PARAMS: readonly IndicatorParamKey[] = [
  'fastPeriod',
  'slowPeriod',
  'signalPeriod',
  'source',
];
const BAND_PARAMS: readonly IndicatorParamKey[] = ['multiplier', 'source'];

export const INDICATORS: readonly IndicatorInfo[] = [
  {
    kind: 'Rsi',
    hint: 'Relative Strength Index — momentum oscillator, 0-100; <30 oversold, >70 overbought',
    scale: 'oscillator',
    params: ['source'],
  },
  {
    kind: 'Atr',
    hint: 'Average True Range — volatility in price units',
    scale: 'other',
    params: [],
  },
  {
    kind: 'AtrRatio',
    hint: 'Short ATR ÷ long ATR — volatility regime (>1 = expanding)',
    scale: 'other',
    params: ['longPeriod'],
  },
  {
    kind: 'Adx',
    hint: 'Average Directional Index — trend strength, 0-100; >25 strong trend',
    scale: 'oscillator',
    params: [],
  },
  {
    kind: 'Momentum',
    hint: 'Momentum — close compared with the close N bars ago (>0 = higher)',
    scale: 'other',
    params: ['source'],
  },
  {
    kind: 'Sma',
    hint: 'Simple Moving Average (a price level)',
    scale: 'price',
    params: ['source'],
  },
  {
    kind: 'Ema',
    hint: 'Exponential Moving Average — recent prices weighted heavier (a price level)',
    scale: 'price',
    params: ['source'],
  },
  {
    kind: 'Macd',
    hint: 'MACD line — fast EMA minus slow EMA (>0 = fast above slow)',
    scale: 'other',
    params: MACD_PARAMS,
  },
  {
    kind: 'MacdSignal',
    hint: 'MACD signal line — EMA of the MACD line',
    scale: 'other',
    params: MACD_SIGNAL_PARAMS,
  },
  {
    kind: 'MacdHistogram',
    hint: 'MACD histogram — MACD line minus signal line',
    scale: 'other',
    params: MACD_SIGNAL_PARAMS,
  },
  {
    kind: 'BollingerBandWidth',
    hint: 'Bollinger band width — (upper − lower) ÷ middle, dimensionless',
    scale: 'other',
    params: BAND_PARAMS,
  },
  {
    kind: 'BollingerBandUpper',
    hint: 'Upper Bollinger band — middle + N std-dev (a price level)',
    scale: 'price',
    params: BAND_PARAMS,
  },
  {
    kind: 'BollingerBandLower',
    hint: 'Lower Bollinger band — middle − N std-dev (a price level)',
    scale: 'price',
    params: BAND_PARAMS,
  },
  {
    kind: 'StochasticK',
    hint: 'Stochastic %K — close within the N-bar range, 0-100',
    scale: 'oscillator',
    params: ['smoothK'],
  },
  {
    kind: 'StochasticD',
    hint: 'Stochastic %D — smoothed %K, 0-100',
    scale: 'oscillator',
    params: ['smoothK', 'smoothD'],
  },
  {
    kind: 'Cci',
    hint: 'Commodity Channel Index — deviation from the mean, ±100 levels',
    scale: 'other',
    params: ['source'],
  },
  {
    kind: 'Vwap',
    hint: 'Volume-Weighted Average Price (a price level)',
    scale: 'price',
    params: ['source'],
  },
  {
    kind: 'RocPercent',
    hint: 'Rate of change — percent change from the close N bars ago',
    scale: 'other',
    params: ['source'],
  },
];

export const INDICATOR_KINDS: readonly string[] = INDICATORS.map((i) => i.kind);

export interface ConditionTypeInfo {
  type: string;
  label: string;
  description: string;
  /** Known payload fields, canonical camelCase. */
  fields: readonly string[];
  /** Carries an indicator and therefore accepts the optional `params`. */
  indicatorBearing: boolean;
}

/** Every condition type the engine evaluates. Help text and pickers read this list. */
export const CONDITION_TYPES: readonly ConditionTypeInfo[] = [
  {
    type: 'IndicatorThreshold',
    label: 'Indicator vs value',
    description: 'An indicator compared with a number, e.g. RSI(14) < 30',
    fields: ['indicator', 'period', 'operator', 'value', 'offset', 'params'],
    indicatorBearing: true,
  },
  {
    type: 'PriceVsMa',
    label: 'Price vs moving average',
    description: 'The close compared with its simple moving average, e.g. close > SMA(200)',
    fields: ['maPeriod', 'operator'],
    indicatorBearing: false,
  },
  {
    type: 'RegimeMatch',
    label: 'Market regime',
    description: 'The detected market regime is one of the allowed regimes',
    fields: ['allowedRegimes'],
    indicatorBearing: false,
  },
  {
    type: 'HourWindow',
    label: 'Hour window (UTC)',
    description: 'The bar opens inside a UTC hour window (wraps past midnight)',
    fields: ['startHourUtc', 'endHourUtc'],
    indicatorBearing: false,
  },
  {
    type: 'IndicatorComparison',
    label: 'Indicator vs indicator',
    description: 'Two indicators compared, e.g. EMA(20) > EMA(50)',
    fields: [
      'leftIndicator',
      'leftPeriod',
      'rightIndicator',
      'rightPeriod',
      'operator',
      'offset',
      'params',
    ],
    indicatorBearing: true,
  },
  {
    type: 'IndicatorCrossover',
    label: 'Crosses above',
    description: 'One indicator crossed above another on the last bar',
    fields: ['leftIndicator', 'leftPeriod', 'rightIndicator', 'rightPeriod', 'params'],
    indicatorBearing: true,
  },
  {
    type: 'IndicatorCrossunder',
    label: 'Crosses below',
    description: 'One indicator crossed below another on the last bar',
    fields: ['leftIndicator', 'leftPeriod', 'rightIndicator', 'rightPeriod', 'params'],
    indicatorBearing: true,
  },
  {
    type: 'VolumeRatio',
    label: 'Volume vs average',
    description: 'Bar volume divided by its N-bar average, e.g. > 1.5',
    fields: ['lookbackBars', 'operator', 'threshold'],
    indicatorBearing: false,
  },
  {
    type: 'BarsSince',
    label: 'Bars since',
    description: 'Bars since another condition was last true, e.g. RSI < 30 within 5 bars',
    fields: ['inner', 'maxLookback', 'operator', 'value'],
    indicatorBearing: false,
  },
  {
    type: 'Spread',
    label: 'Spread',
    description:
      'The bid/ask spread in pips or as a fraction of ATR (on v1 math: the bar range — see BarRange)',
    fields: ['operator', 'threshold', 'mode', 'atrPeriod'],
    indicatorBearing: false,
  },
  {
    type: 'CandlePattern',
    label: 'Candle pattern',
    description: 'A candlestick pattern on the last closed bar',
    fields: ['pattern', 'bullish'],
    indicatorBearing: false,
  },
  {
    type: 'MathExpression',
    label: 'Math expression',
    description: 'Arithmetic over bar fields and indicators, e.g. (High - Low) / Atr(14) > 1.5',
    fields: ['expression', 'operator', 'threshold'],
    indicatorBearing: false,
  },
  {
    type: 'HtfIndicatorThreshold',
    label: 'Higher-timeframe indicator',
    description: 'An indicator on a higher timeframe compared with a number',
    fields: ['higherTimeframe', 'indicator', 'period', 'operator', 'value', 'params'],
    indicatorBearing: true,
  },
  {
    type: 'BarRange',
    label: 'Bar range',
    description: "The last bar's high − low in pips or as a fraction of ATR",
    fields: ['operator', 'threshold', 'mode', 'atrPeriod'],
    indicatorBearing: false,
  },
];

export const CONDITION_TYPE_NAMES: readonly string[] = CONDITION_TYPES.map((t) => t.type);

/** Condition types allowed inside `BarsSince.inner` — everything but BarsSince itself. */
export const BARS_SINCE_INNER_TYPES: readonly string[] = CONDITION_TYPE_NAMES.filter(
  (t) => t !== 'BarsSince',
);

/** Engine validator limits (`LlmDslValidator`). */
export const DSL_LIMITS = {
  minPeriod: 2,
  maxPeriod: 500,
  maxOffset: 500,
  maxBarsSinceLookback: 500,
  maxTreeDepth: 8,
  minAtrMultiplierExclusive: 0.05,
  maxAtrMultiplier: 10,
  maxExpressionLength: 500,
} as const;

export const CURRENT_DSL_VERSION = 2;

// ── Model ───────────────────────────────────────────────────────────────────

/** One condition (the engine's `LlmCondition`). */
export interface DslCondition {
  /** Condition type; '' when the stored condition has none. */
  type: string;
  /**
   * The payload for {@link type}. Known keys are canonical camelCase, unknown
   * keys keep their original spelling. A BarsSince payload holds its `inner`
   * condition as a parsed {@link DslCondition}.
   */
  config: Record<string, any>;
  /** Every other key on the condition object, verbatim. */
  extra?: Record<string, unknown>;
}

/** One node of a condition tree (the engine's `ConditionGroup`). */
export interface DslNode {
  /** Stable id for rendering and issue lookup; not part of the stored JSON. */
  uid: string;
  /** Group operator; null for a leaf (or an unrecognised node). */
  op: string | null;
  children: DslNode[];
  leaf?: DslCondition;
  /** Unknown keys on the node object, verbatim. */
  extra?: Record<string, unknown>;
  /** Set when the node's shape was not recognised; emitted verbatim. */
  raw?: unknown;
}

export interface DslDoc {
  /** Known scalar top-level fields under canonical camelCase keys. */
  fields: Record<string, unknown>;
  entryRoot: DslNode | null;
  exitRoot: DslNode | null;
  /**
   * True when {@link entryRoot} was built from the legacy flat
   * `entryConditions` list. The next emit writes it as `entryConditionsRoot`.
   */
  entryFromLegacyList: boolean;
  /** Unknown top-level keys, verbatim. */
  extra: Record<string, unknown>;
}

export type DslParseResult = { ok: true; doc: DslDoc } | { ok: false; error: string };

export type DslIssueSeverity = 'error' | 'warning';

export interface DslIssue {
  /** Engine-style path, e.g. `entryConditionsRoot.children[1].leaf.indicatorThreshold.period`. */
  path: string;
  message: string;
  severity: DslIssueSeverity;
}

export interface DslValidationContext {
  /** The strategy's own timeframe — HTF conditions must be strictly higher. */
  timeframe?: string | null;
  /** The strategy's own symbol — used only to flag a DSL that names another one. */
  symbol?: string | null;
}

const SCALAR_FIELDS = [
  'dslVersion',
  'name',
  'description',
  'symbol',
  'timeframe',
  'direction',
  'stopLossAtrMultiplier',
  'takeProfitAtrMultiplier',
  'atrPeriod',
  'baseConfidence',
] as const;

const FIELDS_BEFORE_TREES = [
  'dslVersion',
  'name',
  'description',
  'symbol',
  'timeframe',
  'direction',
];
const FIELDS_AFTER_TREES = [
  'stopLossAtrMultiplier',
  'takeProfitAtrMultiplier',
  'atrPeriod',
  'baseConfidence',
];

// ── Small helpers ───────────────────────────────────────────────────────────

let uidCounter = 0;
export function nextUid(): string {
  return `n${++uidCounter}`;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function lower(s: string): string {
  return s.toLowerCase();
}

/** Canonical spelling of `value` from `list` when it matches case-insensitively. */
export function canon<T extends string>(value: unknown, list: readonly T[]): unknown {
  if (typeof value !== 'string') return value;
  const hit = list.find((x) => lower(x) === lower(value));
  return hit ?? value;
}

/** Lower-cases the first character: `IndicatorThreshold` → `indicatorThreshold`. */
export function payloadKey(type: string): string {
  return type ? type.charAt(0).toLowerCase() + type.slice(1) : type;
}

/** Numeric value of `v` (engine reads numeric strings too); null when not a number. */
export function numeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function timeframeRank(tf: unknown): number {
  if (typeof tf !== 'string') return -1;
  return (ENGINE_TIMEFRAMES as readonly string[]).findIndex((t) => lower(t) === lower(tf));
}

/** Engine timeframes strictly higher than `tf`; all of them when `tf` is unknown. */
export function higherTimeframes(tf: string | null | undefined): EngineTimeframe[] {
  const rank = timeframeRank(tf);
  if (rank < 0) return [...ENGINE_TIMEFRAMES];
  return ENGINE_TIMEFRAMES.filter((_, i) => i > rank);
}

export function indicatorInfo(kind: unknown): IndicatorInfo | undefined {
  return typeof kind === 'string'
    ? INDICATORS.find((i) => lower(i.kind) === lower(kind))
    : undefined;
}

export function conditionTypeInfo(type: unknown): ConditionTypeInfo | undefined {
  return typeof type === 'string'
    ? CONDITION_TYPES.find((t) => lower(t.type) === lower(type))
    : undefined;
}

export function comparatorSymbol(op: unknown): string {
  return COMPARATORS.find((c) => c.value === op)?.symbol ?? String(op ?? '?');
}

/** The params keys that change the value of any of the condition's indicators. */
export function relevantParamKeys(cond: DslCondition): IndicatorParamKey[] {
  const info = conditionTypeInfo(cond.type);
  if (!info?.indicatorBearing) return [];
  const kinds = [
    cond.config['indicator'],
    cond.config['leftIndicator'],
    cond.config['rightIndicator'],
  ];
  const keys = new Set<IndicatorParamKey>();
  for (const k of kinds) for (const p of indicatorInfo(k)?.params ?? []) keys.add(p);
  // Keep the catalogue order so the editor lays fields out consistently.
  return INDICATOR_PARAMS.map((p) => p.key).filter((k) => keys.has(k));
}

// ── Parsing (any casing in) ─────────────────────────────────────────────────

/** Looks a key up case-insensitively; returns the actual key or undefined. */
function findKey(obj: Record<string, any>, name: string): string | undefined {
  if (name in obj) return name;
  const want = lower(name);
  return Object.keys(obj).find((k) => lower(k) === want);
}

/**
 * Re-keys an object: every key that matches one of `known` case-insensitively
 * gets the canonical spelling; everything else is kept verbatim. When both a
 * canonical and a differently-cased duplicate are present, the canonical one
 * wins and the duplicate is dropped (the engine would read only one of them).
 */
function canonicalKeys(
  obj: Record<string, any>,
  known: readonly string[],
): { known: Record<string, any>; unknown: Record<string, any> } {
  const out: Record<string, any> = {};
  const rest: Record<string, any> = {};
  const byLower = new Map(known.map((k) => [lower(k), k]));
  for (const [k, v] of Object.entries(obj)) {
    const canonical = byLower.get(lower(k));
    if (canonical === undefined) {
      rest[k] = v;
      continue;
    }
    if (canonical in out && k !== canonical) continue;
    out[canonical] = v;
  }
  return { known: out, unknown: rest };
}

function parseParams(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const { known, unknown } = canonicalKeys(
    raw,
    INDICATOR_PARAMS.map((p) => p.key),
  );
  if ('source' in known) known['source'] = canon(known['source'], PRICE_SOURCES);
  return { ...known, ...unknown };
}

/** Parses one condition object (`LlmCondition`) in any casing. */
export function parseCondition(raw: unknown): DslCondition {
  if (!isPlainObject(raw)) return { type: '', config: {}, extra: { value: raw } };
  const typeKey = findKey(raw, 'type');
  const rawType = typeKey !== undefined ? raw[typeKey] : undefined;
  const type = typeof rawType === 'string' ? String(canon(rawType, CONDITION_TYPE_NAMES)) : '';
  const extra: Record<string, unknown> = {};

  const payloadKeyName = type ? findKey(raw, payloadKey(type)) : undefined;
  for (const [k, v] of Object.entries(raw)) {
    if (k === typeKey || k === payloadKeyName) continue;
    // Stale null payloads for other types carry no information; drop them.
    if (v === null && conditionTypeInfo(k.charAt(0).toUpperCase() + k.slice(1))) continue;
    extra[k] = v;
  }
  if (typeKey !== undefined && typeof rawType !== 'string') extra[typeKey] = rawType;

  const payload = payloadKeyName !== undefined ? raw[payloadKeyName] : undefined;
  const info = conditionTypeInfo(type);
  let config: Record<string, any> = {};
  if (isPlainObject(payload) && info) {
    const { known, unknown } = canonicalKeys(payload, info.fields);
    config = { ...known, ...unknown };
    canonicaliseConfigValues(type, config);
  } else if (isPlainObject(payload)) {
    config = { ...payload };
  } else if (payload !== undefined && payloadKeyName !== undefined) {
    // A non-object payload (null, number…) is kept as-is so it round-trips.
    extra[payloadKeyName] = payload;
  }
  return Object.keys(extra).length > 0 ? { type, config, extra } : { type, config };
}

function canonicaliseConfigValues(type: string, config: Record<string, any>): void {
  for (const k of ['indicator', 'leftIndicator', 'rightIndicator']) {
    if (k in config) config[k] = canon(config[k], INDICATOR_KINDS);
  }
  if ('operator' in config)
    config['operator'] = canon(
      config['operator'],
      COMPARATORS.map((c) => c.value),
    );
  if ('higherTimeframe' in config)
    config['higherTimeframe'] = canon(config['higherTimeframe'], ENGINE_TIMEFRAMES);
  if ('pattern' in config) config['pattern'] = canon(config['pattern'], CANDLE_PATTERNS);
  if ('mode' in config) config['mode'] = canon(config['mode'], RANGE_MODES);
  if (Array.isArray(config['allowedRegimes'])) {
    config['allowedRegimes'] = config['allowedRegimes'].map((r: unknown) =>
      canon(r, MARKET_REGIMES),
    );
  }
  if ('params' in config) config['params'] = parseParams(config['params']);
  if (type === 'BarsSince' && isPlainObject(config['inner'])) {
    config['inner'] = parseCondition(config['inner']);
  }
}

/** Parses one tree node (`ConditionGroup`) in any casing. */
export function parseNode(raw: unknown): DslNode {
  if (!isPlainObject(raw)) return { uid: nextUid(), op: null, children: [], raw };
  const opKey = findKey(raw, 'op');
  const childrenKey = findKey(raw, 'children');
  const leafKey = findKey(raw, 'leaf');
  const op = opKey !== undefined ? raw[opKey] : null;
  const children = childrenKey !== undefined ? raw[childrenKey] : undefined;
  const leaf = leafKey !== undefined ? raw[leafKey] : undefined;

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === opKey || k === childrenKey || k === leafKey) continue;
    extra[k] = v;
  }

  if (typeof op === 'string' && op.trim() !== '') {
    // A group. A stray non-null leaf stays with the node so nothing is lost —
    // the validator flags the mixed node.
    if (leaf !== undefined && leaf !== null) extra[leafKey!] = leaf;
    if (children !== undefined && children !== null && !Array.isArray(children)) {
      extra[childrenKey!] = children;
    }
    return withExtra(
      {
        uid: nextUid(),
        op: String(canon(op, LOGIC_OPS)),
        children: Array.isArray(children) ? children.map(parseNode) : [],
      },
      extra,
    );
  }
  if (op === null || op === undefined) {
    if (isPlainObject(leaf)) {
      if (Array.isArray(children) && children.length > 0) extra[childrenKey!] = children;
      return withExtra(
        { uid: nextUid(), op: null, children: [], leaf: parseCondition(leaf) },
        extra,
      );
    }
  }
  // Neither a group nor a leaf the engine would accept — keep it verbatim.
  return { uid: nextUid(), op: null, children: [], raw };
}

function withExtra(node: DslNode, extra: Record<string, unknown>): DslNode {
  return Object.keys(extra).length > 0 ? { ...node, extra } : node;
}

/** Builds a {@link DslDoc} from an already-parsed JSON value. */
export function docFromObject(obj: unknown): DslParseResult {
  if (!isPlainObject(obj)) return { ok: false, error: 'The DSL must be a JSON object' };
  const fields: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  let entryRoot: DslNode | null = null;
  let exitRoot: DslNode | null = null;
  let legacyList: unknown = undefined;
  let legacyKey: string | undefined;
  let entryRootSeen = false;

  const scalarByLower = new Map<string, string>(SCALAR_FIELDS.map((k) => [lower(k), k]));
  for (const [k, v] of Object.entries(obj)) {
    const lk = lower(k);
    const scalar = scalarByLower.get(lk);
    if (scalar !== undefined) {
      if (scalar in fields && k !== scalar) continue;
      fields[scalar] = v;
      continue;
    }
    if (lk === 'entryconditionsroot') {
      if (v !== null && v !== undefined) entryRoot = parseNode(v);
      entryRootSeen = true;
      continue;
    }
    if (lk === 'exitconditionsroot') {
      if (v !== null && v !== undefined) exitRoot = parseNode(v);
      continue;
    }
    if (lk === 'entryconditions') {
      legacyList = v;
      legacyKey = k;
      continue;
    }
    extra[k] = v;
  }

  if ('direction' in fields) fields['direction'] = canon(fields['direction'], DIRECTIONS);
  if ('timeframe' in fields) fields['timeframe'] = canon(fields['timeframe'], ENGINE_TIMEFRAMES);
  if ('dslVersion' in fields) {
    const n = numeric(fields['dslVersion']);
    if (n !== null) fields['dslVersion'] = n;
  }

  let entryFromLegacyList = false;
  if (legacyKey !== undefined) {
    if (entryRoot === null && Array.isArray(legacyList) && legacyList.length > 0) {
      // The flat list is an implicit AND. A single condition becomes the root
      // leaf itself — the engine rejects an AND with one child.
      const leaves = legacyList.map(
        (c): DslNode => ({ uid: nextUid(), op: null, children: [], leaf: parseCondition(c) }),
      );
      entryRoot = leaves.length === 1 ? leaves[0] : { uid: nextUid(), op: 'And', children: leaves };
      entryFromLegacyList = true;
    } else if (!(entryRootSeen && Array.isArray(legacyList) && legacyList.length === 0)) {
      // Ignored by the engine when a root exists, but it is the operator's
      // data — keep it verbatim.
      extra[legacyKey] = legacyList;
    }
  }

  return { ok: true, doc: { fields, entryRoot, exitRoot, entryFromLegacyList, extra } };
}

/** Parses DSL JSON text. Never throws. */
export function parseDsl(json: string | null | undefined): DslParseResult {
  if (!json || !json.trim()) return { ok: false, error: 'The DSL is empty' };
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error)?.message ?? 'parse error'}` };
  }
  return docFromObject(obj);
}

// ── Emission (camelCase out) ────────────────────────────────────────────────

export function emitCondition(c: DslCondition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.type) out['type'] = c.type;
  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c.config ?? {})) {
    if (v === undefined) continue;
    config[k] = k === 'inner' && isCondition(v) ? emitCondition(v) : v;
  }
  if (c.type && Object.keys(config).length > 0) out[payloadKey(c.type)] = config;
  for (const [k, v] of Object.entries(c.extra ?? {})) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

function isCondition(v: unknown): v is DslCondition {
  return isPlainObject(v) && typeof v['type'] === 'string' && isPlainObject(v['config']);
}

export function emitNode(n: DslNode): unknown {
  if (n.raw !== undefined) return n.raw;
  const out: Record<string, unknown> = {};
  if (n.op !== null) {
    out['op'] = n.op;
    out['children'] = n.children.map(emitNode);
  } else if (n.leaf) {
    out['leaf'] = emitCondition(n.leaf);
  }
  for (const [k, v] of Object.entries(n.extra ?? {})) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

export function docToObject(doc: DslDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string) => {
    const v = doc.fields[k];
    if (v !== undefined && v !== null) out[k] = v;
  };
  FIELDS_BEFORE_TREES.forEach(put);
  if (doc.entryRoot) out['entryConditionsRoot'] = emitNode(doc.entryRoot);
  if (doc.exitRoot) out['exitConditionsRoot'] = emitNode(doc.exitRoot);
  FIELDS_AFTER_TREES.forEach(put);
  for (const [k, v] of Object.entries(doc.extra)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/** Serialises a doc as pretty-printed camelCase JSON. */
export function emitDsl(doc: DslDoc): string {
  return JSON.stringify(docToObject(doc), null, 2);
}

/** Re-emits DSL JSON in canonical camelCase; returns the input when it does not parse. */
export function canonicaliseDslJson(json: string): string {
  const r = parseDsl(json);
  return r.ok ? emitDsl(r.doc) : json;
}

// ── Construction helpers ────────────────────────────────────────────────────

export interface DslDefaultsContext {
  timeframe?: string | null;
}

/** A fresh payload for `type` — every default is a valid, meaningful condition. */
export function defaultConfig(type: string, ctx: DslDefaultsContext = {}): Record<string, any> {
  switch (type) {
    case 'IndicatorThreshold':
      return { indicator: 'Rsi', period: 14, operator: 'LessThan', value: 30 };
    case 'PriceVsMa':
      return { maPeriod: 200, operator: 'GreaterThan' };
    case 'RegimeMatch':
      return { allowedRegimes: ['Trending'] };
    case 'HourWindow':
      return { startHourUtc: 7, endHourUtc: 16 };
    case 'IndicatorComparison':
      return {
        leftIndicator: 'Ema',
        leftPeriod: 20,
        operator: 'GreaterThan',
        rightIndicator: 'Ema',
        rightPeriod: 50,
      };
    case 'IndicatorCrossover':
    case 'IndicatorCrossunder':
      return { leftIndicator: 'Ema', leftPeriod: 20, rightIndicator: 'Ema', rightPeriod: 50 };
    case 'VolumeRatio':
      return { lookbackBars: 20, operator: 'GreaterThan', threshold: 1.5 };
    case 'BarsSince':
      return {
        inner: newCondition('IndicatorThreshold', ctx),
        maxLookback: 50,
        operator: 'LessThanOrEqual',
        value: 5,
      };
    case 'Spread':
      return { operator: 'LessThan', threshold: 2, mode: 'Pips' };
    case 'BarRange':
      return { operator: 'GreaterThan', threshold: 1.5, mode: 'AtrFraction', atrPeriod: 14 };
    case 'CandlePattern':
      return { pattern: 'PinBar', bullish: true };
    case 'MathExpression':
      return { expression: '(High - Low) / Atr(14)', operator: 'GreaterThan', threshold: 1.5 };
    case 'HtfIndicatorThreshold':
      return {
        // The next timeframe up from the strategy's; D1 when that is unknown.
        higherTimeframe:
          timeframeRank(ctx.timeframe) >= 0 ? (higherTimeframes(ctx.timeframe)[0] ?? 'D1') : 'D1',
        indicator: 'Rsi',
        period: 14,
        operator: 'GreaterThan',
        value: 50,
      };
    default:
      return {};
  }
}

export function newCondition(type: string, ctx: DslDefaultsContext = {}): DslCondition {
  return { type, config: defaultConfig(type, ctx) };
}

export function newLeafNode(type = 'IndicatorThreshold', ctx: DslDefaultsContext = {}): DslNode {
  return { uid: nextUid(), op: null, children: [], leaf: newCondition(type, ctx) };
}

export function newGroupNode(op = 'And', children: DslNode[] = []): DslNode {
  return { uid: nextUid(), op, children };
}

export interface NewDocOptions {
  name?: string | null;
  symbol?: string | null;
  timeframe?: string | null;
}

/** A new, valid v2 document with one starter condition. */
export function newDoc(opts: NewDocOptions = {}): DslDoc {
  return {
    fields: {
      dslVersion: CURRENT_DSL_VERSION,
      name: opts.name?.trim() || 'New rule',
      symbol: opts.symbol?.trim() || 'EURUSD',
      timeframe: canon(opts.timeframe ?? 'H1', ENGINE_TIMEFRAMES),
      direction: 'Buy',
      stopLossAtrMultiplier: 1.5,
      takeProfitAtrMultiplier: 2.5,
      atrPeriod: 14,
      baseConfidence: 0.5,
    },
    entryRoot: newLeafNode('IndicatorThreshold', { timeframe: opts.timeframe }),
    exitRoot: null,
    entryFromLegacyList: false,
    extra: {},
  };
}

/** The version the engine will use: an absent `dslVersion` means v1. */
export function effectiveDslVersion(doc: DslDoc): number {
  const v = numeric(doc.fields['dslVersion']);
  return v === null ? 1 : v;
}

/** Visits every condition (including BarsSince inners) with its engine path. */
export function forEachCondition(
  doc: DslDoc,
  visit: (cond: DslCondition, path: string, node: DslNode) => void,
): void {
  const walkCond = (c: DslCondition, path: string, node: DslNode) => {
    visit(c, path, node);
    const inner = c.config?.['inner'];
    if (c.type === 'BarsSince' && isCondition(inner)) {
      walkCond(inner, `${path}.${payloadKey(c.type)}.inner`, node);
    }
  };
  walkTree(doc, (n, paths) => {
    if (n.op === null && n.leaf) walkCond(n.leaf, paths.condPath, n);
  });
}

interface NodePaths {
  nodePath: string;
  condPath: string;
  depth: number;
  tree: 'entry' | 'exit';
}

/**
 * Walks both trees, handing every node its engine path. For an entry tree
 * built from the legacy flat list the paths are `entryConditions[i]` (the
 * list holds bare conditions, no `leaf` wrapper) — that is what the engine
 * reports for a DSL that has not been re-saved yet.
 */
function walkTree(doc: DslDoc, visit: (n: DslNode, p: NodePaths) => void): void {
  const walk = (n: DslNode, nodePath: string, depth: number, tree: 'entry' | 'exit') => {
    visit(n, { nodePath, condPath: `${nodePath}.leaf`, depth, tree });
    if (n.op !== null) {
      n.children.forEach((c, i) => walk(c, `${nodePath}.children[${i}]`, depth + 1, tree));
    }
  };
  if (doc.entryRoot) {
    if (doc.entryFromLegacyList) {
      const root = doc.entryRoot;
      const items = root.op !== null ? root.children : [root];
      items.forEach((c, i) =>
        visit(c, {
          nodePath: `entryConditions[${i}]`,
          condPath: `entryConditions[${i}]`,
          depth: 1,
          tree: 'entry',
        }),
      );
    } else {
      walk(doc.entryRoot, 'entryConditionsRoot', 0, 'entry');
    }
  }
  if (doc.exitRoot) walk(doc.exitRoot, 'exitConditionsRoot', 0, 'exit');
}

// ── Transforms ──────────────────────────────────────────────────────────────

/**
 * Moves a document to v2 math the way the engine's upgrade does for the
 * part that changes meaning: a v1 `Spread` measured the bar's high − low,
 * which v2 calls `BarRange` (v2 `Spread` is the real bid/ask spread). Every
 * Spread condition, including BarsSince inners, becomes a BarRange with the
 * same fields. Returns the number converted.
 */
export function upgradeDocToV2(doc: DslDoc): number {
  let converted = 0;
  forEachCondition(doc, (c) => {
    if (c.type === 'Spread') {
      c.type = 'BarRange';
      converted++;
    }
  });
  doc.fields['dslVersion'] = CURRENT_DSL_VERSION;
  return converted;
}

/**
 * Sets top-level fields on DSL JSON and re-emits it; null when the JSON does
 * not parse (the caller leaves it alone then).
 */
export function patchDslFields(json: string, patch: Record<string, unknown>): string | null {
  const r = parseDsl(json);
  if (!r.ok) return null;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === '') delete r.doc.fields[k];
    else r.doc.fields[k] = v;
  }
  return emitDsl(r.doc);
}

// ── Validation ──────────────────────────────────────────────────────────────

function issue(path: string, message: string, severity: DslIssueSeverity = 'error'): DslIssue {
  return { path, message, severity };
}

function checkInt(
  out: DslIssue[],
  path: string,
  label: string,
  v: unknown,
  min: number,
  max: number,
  required = true,
): void {
  if (v === undefined || v === null || v === '') {
    if (required) out.push(issue(path, `${label} is required`));
    return;
  }
  const n = numeric(v);
  if (n === null || !Number.isInteger(n)) {
    out.push(issue(path, `${label} must be a whole number`));
    return;
  }
  if (n < min || n > max) out.push(issue(path, `${label} ${n} is outside [${min}, ${max}]`));
}

function checkEnum(
  out: DslIssue[],
  path: string,
  label: string,
  v: unknown,
  list: readonly string[],
  required = true,
): void {
  if (v === undefined || v === null || v === '') {
    if (required) out.push(issue(path, `${label} is required`));
    return;
  }
  if (typeof v !== 'string' || !list.includes(v)) {
    out.push(issue(path, `${label} '${String(v)}' is not one of ${list.join(', ')}`));
  }
}

function checkPositive(out: DslIssue[], path: string, label: string, v: unknown): void {
  if (v === undefined || v === null || v === '') {
    out.push(issue(path, `${label} is required`));
    return;
  }
  const n = numeric(v);
  if (n === null) out.push(issue(path, `${label} must be a number`));
  else if (n <= 0) out.push(issue(path, `${label} ${n} must be positive`));
}

function checkNumber(out: DslIssue[], path: string, label: string, v: unknown): number | null {
  if (v === undefined || v === null || v === '') {
    out.push(issue(path, `${label} is required`));
    return null;
  }
  const n = numeric(v);
  if (n === null) out.push(issue(path, `${label} must be a number`));
  return n;
}

const COMPARATOR_VALUES = COMPARATORS.map((c) => c.value);

/** Outcome of `x op v` when x is known to be > 0 (price) or in [0, 100] (oscillator). */
function constantOutcome(
  scale: IndicatorInfo['scale'],
  op: unknown,
  v: number,
): 'always' | 'never' | null {
  if (scale === 'price') {
    // A price level is always positive.
    if (v > 0) return null;
    if (op === 'GreaterThan' || op === 'GreaterThanOrEqual' || op === 'NotEqual') return 'always';
    if (op === 'LessThan' || op === 'LessThanOrEqual' || op === 'Equal') return 'never';
    return null;
  }
  if (scale === 'oscillator') {
    switch (op) {
      case 'GreaterThan':
        return v >= 100 ? 'never' : v < 0 ? 'always' : null;
      case 'GreaterThanOrEqual':
        return v > 100 ? 'never' : v <= 0 ? 'always' : null;
      case 'LessThan':
        return v <= 0 ? 'never' : v > 100 ? 'always' : null;
      case 'LessThanOrEqual':
        return v < 0 ? 'never' : v >= 100 ? 'always' : null;
      case 'Equal':
        return v < 0 || v > 100 ? 'never' : null;
      case 'NotEqual':
        return v < 0 || v > 100 ? 'always' : null;
    }
  }
  return null;
}

/** Bollinger ordering over the same period: lower ≤ middle (SMA) ≤ upper. */
function bandRank(kind: unknown): number | null {
  switch (kind) {
    case 'BollingerBandLower':
      return 0;
    case 'Sma':
      return 1;
    case 'BollingerBandUpper':
      return 2;
    default:
      return null;
  }
}

function describeInd(kind: unknown, period: unknown): string {
  return `${String(kind ?? '?')}(${String(period ?? '?')})`;
}

function validateParams(out: DslIssue[], cond: DslCondition, path: string, version: number): void {
  const params = cond.config['params'];
  if (params === undefined || params === null) return;
  const p = `${path}.params`;
  if (!isPlainObject(params)) {
    out.push(issue(p, 'params must be an object'));
    return;
  }
  if (version < 2) {
    out.push(
      issue(
        p,
        'Indicator params are a v2 (Pine-exact math) feature — v1 math may ignore them',
        'warning',
      ),
    );
  }
  const relevant = relevantParamKeys(cond);
  for (const info of INDICATOR_PARAMS) {
    if (!(info.key in params)) continue;
    const v = params[info.key];
    const fp = `${p}.${info.key}`;
    if (v === null || v === undefined || v === '') continue;
    if (info.kind === 'int') checkInt(out, fp, info.label, v, 1, DSL_LIMITS.maxPeriod, false);
    else if (info.kind === 'decimal') checkPositive(out, fp, info.label, v);
    else checkEnum(out, fp, info.label, v, PRICE_SOURCES, false);
    if (!relevant.includes(info.key)) {
      out.push(issue(fp, `${info.label} has no effect on the selected indicator(s)`, 'warning'));
    }
  }
  const fast = numeric(params['fastPeriod']);
  const slow = numeric(params['slowPeriod']);
  if (fast !== null && slow !== null && fast >= slow) {
    out.push(
      issue(`${p}.fastPeriod`, 'fast period should be shorter than the slow period', 'warning'),
    );
  }
}

/** Validates one condition's payload. `path` is the condition's path (…`.leaf`). */
function validateCondition(
  out: DslIssue[],
  cond: DslCondition,
  path: string,
  ctx: DslValidationContext,
  version: number,
  allowBarsSince: boolean,
): void {
  if (!cond.type) {
    out.push(issue(path, 'Condition has no type'));
    return;
  }
  const info = conditionTypeInfo(cond.type);
  if (!info) {
    out.push(issue(path, `Unknown condition type '${cond.type}'`));
    return;
  }
  if (cond.type === 'BarsSince' && !allowBarsSince) {
    out.push(issue(path, 'BarsSince cannot be nested inside another BarsSince'));
    return;
  }
  const c = cond.config ?? {};
  const pk = payloadKey(cond.type);
  const fp = (field: string) => `${path}.${pk}.${field}`;
  const { minPeriod, maxPeriod, maxOffset } = DSL_LIMITS;

  if (Object.keys(c).length === 0) {
    out.push(issue(path, `${cond.type} payload is missing`));
    return;
  }

  switch (cond.type) {
    case 'IndicatorThreshold':
    case 'HtfIndicatorThreshold': {
      checkEnum(out, fp('indicator'), 'indicator', c['indicator'], INDICATOR_KINDS);
      checkInt(out, fp('period'), 'period', c['period'], minPeriod, maxPeriod);
      checkEnum(out, fp('operator'), 'operator', c['operator'], COMPARATOR_VALUES);
      const v = checkNumber(out, fp('value'), 'value', c['value']);
      if (cond.type === 'IndicatorThreshold') {
        checkInt(out, fp('offset'), 'offset (bars ago)', c['offset'], 0, maxOffset, false);
      } else {
        const htf = c['higherTimeframe'];
        checkEnum(out, fp('higherTimeframe'), 'higher timeframe', htf, ENGINE_TIMEFRAMES);
        const base = timeframeRank(ctx.timeframe);
        const rank = timeframeRank(htf);
        if (base >= 0 && rank >= 0 && rank <= base) {
          out.push(
            issue(
              fp('higherTimeframe'),
              `${String(htf)} is not higher than the strategy's ${String(ctx.timeframe)} — the condition would never fire`,
            ),
          );
        }
      }
      const ind = indicatorInfo(c['indicator']);
      if (ind && v !== null) {
        if (ind.scale === 'oscillator' && (v < -1 || v > 101)) {
          out.push(
            issue(fp('value'), `${ind.kind} threshold ${v} is outside the indicator's 0–100 range`),
          );
        } else if (ind.kind === 'Cci' && (v < -500 || v > 500)) {
          out.push(issue(fp('value'), `CCI threshold ${v} is outside [-500, 500]`));
        } else {
          const outcome = constantOutcome(ind.scale, c['operator'], v);
          if (outcome) {
            const why =
              ind.scale === 'price'
                ? `${describeInd(ind.kind, c['period'])} is a price level and always positive`
                : `${ind.kind} stays within 0–100`;
            out.push(
              issue(
                fp('value'),
                `${why}, so "${comparatorSymbol(c['operator'])} ${v}" is ${outcome} true`,
                'warning',
              ),
            );
          }
        }
      }
      validateParams(out, cond, `${path}.${pk}`, version);
      break;
    }
    case 'PriceVsMa':
      checkInt(out, fp('maPeriod'), 'MA period', c['maPeriod'], minPeriod, maxPeriod);
      checkEnum(out, fp('operator'), 'operator', c['operator'], COMPARATOR_VALUES);
      break;
    case 'RegimeMatch': {
      const regimes = c['allowedRegimes'];
      if (!Array.isArray(regimes) || regimes.length === 0) {
        out.push(
          issue(fp('allowedRegimes'), 'Pick at least one regime — an empty list never matches'),
        );
      } else {
        for (const r of regimes) {
          if (!(MARKET_REGIMES as readonly unknown[]).includes(r)) {
            out.push(
              issue(
                fp('allowedRegimes'),
                `Unknown regime '${String(r)}' — use ${MARKET_REGIMES.join(', ')}`,
              ),
            );
          }
        }
      }
      break;
    }
    case 'HourWindow': {
      checkInt(out, fp('startHourUtc'), 'start hour', c['startHourUtc'], 0, 23);
      checkInt(out, fp('endHourUtc'), 'end hour', c['endHourUtc'], 0, 23);
      const s = numeric(c['startHourUtc']);
      const e = numeric(c['endHourUtc']);
      if (s !== null && s === e) {
        out.push(
          issue(path, 'Start and end hour are equal — a zero-width window never fires', 'warning'),
        );
      }
      break;
    }
    case 'IndicatorComparison':
    case 'IndicatorCrossover':
    case 'IndicatorCrossunder': {
      checkEnum(out, fp('leftIndicator'), 'left indicator', c['leftIndicator'], INDICATOR_KINDS);
      checkInt(out, fp('leftPeriod'), 'left period', c['leftPeriod'], minPeriod, maxPeriod);
      checkEnum(out, fp('rightIndicator'), 'right indicator', c['rightIndicator'], INDICATOR_KINDS);
      checkInt(out, fp('rightPeriod'), 'right period', c['rightPeriod'], minPeriod, maxPeriod);
      const isComparison = cond.type === 'IndicatorComparison';
      if (isComparison) {
        checkEnum(out, fp('operator'), 'operator', c['operator'], COMPARATOR_VALUES);
        checkInt(out, fp('offset'), 'offset (bars ago)', c['offset'], 0, maxOffset, false);
      }
      const l = describeInd(c['leftIndicator'], c['leftPeriod']);
      const r = describeInd(c['rightIndicator'], c['rightPeriod']);
      const samePeriod = numeric(c['leftPeriod']) === numeric(c['rightPeriod']);
      if (c['leftIndicator'] === c['rightIndicator'] && samePeriod) {
        out.push(
          issue(
            path,
            isComparison
              ? `${l} is compared with itself — the result never changes`
              : `${l} can never cross itself`,
            'warning',
          ),
        );
      } else if (samePeriod) {
        const lr = bandRank(c['leftIndicator']);
        const rr = bandRank(c['rightIndicator']);
        if (lr !== null && rr !== null && lr !== rr) {
          if (!isComparison) {
            out.push(
              issue(
                path,
                `${l} and ${r} are Bollinger levels of one band set — they can never cross`,
                'warning',
              ),
            );
          } else {
            const op = c['operator'];
            const above = lr > rr; // left is always ≥ right
            const trueOps = above
              ? ['GreaterThan', 'GreaterThanOrEqual', 'NotEqual']
              : ['LessThan', 'LessThanOrEqual', 'NotEqual'];
            const outcome = trueOps.includes(op) ? 'always' : 'never';
            out.push(
              issue(
                path,
                `${l} is always ${above ? 'at or above' : 'at or below'} ${r}, so this is ${outcome} true`,
                'warning',
              ),
            );
          }
        }
      }
      validateParams(out, cond, `${path}.${pk}`, version);
      break;
    }
    case 'VolumeRatio':
      checkInt(out, fp('lookbackBars'), 'lookback bars', c['lookbackBars'], minPeriod, maxPeriod);
      checkEnum(out, fp('operator'), 'operator', c['operator'], COMPARATOR_VALUES);
      checkPositive(out, fp('threshold'), 'threshold', c['threshold']);
      break;
    case 'BarsSince': {
      const inner = c['inner'];
      if (!isCondition(inner)) {
        out.push(issue(fp('inner'), 'BarsSince needs an inner condition'));
      } else {
        validateCondition(out, inner, fp('inner'), ctx, version, false);
      }
      checkInt(
        out,
        fp('maxLookback'),
        'max lookback',
        c['maxLookback'],
        1,
        DSL_LIMITS.maxBarsSinceLookback,
      );
      checkEnum(out, fp('operator'), 'operator', c['operator'], COMPARATOR_VALUES);
      const count = numeric(c['value']);
      if (c['value'] === undefined || c['value'] === null || c['value'] === '') {
        out.push(issue(fp('value'), 'bar count is required'));
      } else if (count === null || !Number.isInteger(count) || count < 0) {
        out.push(issue(fp('value'), 'bar count must be a whole number ≥ 0'));
      } else {
        const lookback = numeric(c['maxLookback']);
        if (lookback !== null && count > lookback) {
          // The engine scans at most maxLookback bars and treats "not found"
          // as maxLookback + 1, so a count past the window decides nothing.
          out.push(
            issue(
              fp('value'),
              `bar count ${count} is beyond the ${lookback}-bar lookback — the lookback limit decides the result`,
              'warning',
            ),
          );
        }
      }
      break;
    }
    case 'Spread':
    case 'BarRange': {
      checkEnum(out, fp('operator'), 'operator', c['operator'], COMPARATOR_VALUES);
      checkPositive(out, fp('threshold'), 'threshold', c['threshold']);
      const mode = c['mode'] ?? 'Pips';
      checkEnum(out, fp('mode'), 'mode', mode, RANGE_MODES);
      if (mode === 'AtrFraction') {
        checkInt(out, fp('atrPeriod'), 'ATR period', c['atrPeriod'] ?? 14, minPeriod, maxPeriod);
      }
      break;
    }
    case 'CandlePattern': {
      checkEnum(out, fp('pattern'), 'pattern', c['pattern'], CANDLE_PATTERNS);
      const b = c['bullish'];
      if (b !== undefined && b !== null && typeof b !== 'boolean') {
        out.push(issue(fp('bullish'), 'bullish must be true, false or absent (either direction)'));
      }
      break;
    }
    case 'MathExpression': {
      const expr = c['expression'];
      if (typeof expr !== 'string' || expr.trim() === '') {
        out.push(issue(fp('expression'), 'expression is required'));
      } else if (expr.length > DSL_LIMITS.maxExpressionLength) {
        out.push(
          issue(
            fp('expression'),
            `expression exceeds ${DSL_LIMITS.maxExpressionLength} characters`,
          ),
        );
      } else {
        const err = checkMathExpression(expr);
        if (err) out.push(issue(fp('expression'), err));
      }
      checkEnum(out, fp('operator'), 'operator', c['operator'], COMPARATOR_VALUES);
      checkNumber(out, fp('threshold'), 'threshold', c['threshold']);
      break;
    }
  }
}

/**
 * Structural checks mirroring the engine's `LlmDslValidator`, plus lints for
 * rules that are valid but can never (or always) fire. Errors are what the
 * engine rejects; warnings are advisory.
 */
export function validateDsl(doc: DslDoc, ctx: DslValidationContext = {}): DslIssue[] {
  const out: DslIssue[] = [];
  const f = doc.fields;
  const version = effectiveDslVersion(doc);

  if ('dslVersion' in f && f['dslVersion'] !== 1 && f['dslVersion'] !== 2) {
    out.push(issue('dslVersion', `dslVersion ${String(f['dslVersion'])} is not 1 or 2`));
  }
  if (typeof f['name'] !== 'string' || !f['name'].trim())
    out.push(issue('name', 'name is required'));
  if (typeof f['symbol'] !== 'string' || !f['symbol'].trim()) {
    out.push(issue('symbol', 'symbol is required'));
  } else if (ctx.symbol && lower(f['symbol']) !== lower(ctx.symbol)) {
    out.push(
      issue(
        'symbol',
        `The rules name ${f['symbol']} but the strategy trades ${ctx.symbol} — the engine evaluates the strategy's symbol`,
        'warning',
      ),
    );
  }
  checkEnum(out, 'timeframe', 'timeframe', f['timeframe'], ENGINE_TIMEFRAMES);
  if (
    ctx.timeframe &&
    timeframeRank(f['timeframe']) >= 0 &&
    timeframeRank(ctx.timeframe) >= 0 &&
    timeframeRank(f['timeframe']) !== timeframeRank(ctx.timeframe)
  ) {
    out.push(
      issue(
        'timeframe',
        `The rules name ${String(f['timeframe'])} but the strategy runs on ${ctx.timeframe} — the engine evaluates the strategy's timeframe`,
        'warning',
      ),
    );
  }
  checkEnum(out, 'direction', 'direction', f['direction'], DIRECTIONS);
  for (const key of ['stopLossAtrMultiplier', 'takeProfitAtrMultiplier'] as const) {
    const label =
      key === 'stopLossAtrMultiplier' ? 'stop-loss ATR multiple' : 'take-profit ATR multiple';
    const n = checkNumber(out, key, label, f[key]);
    if (
      n !== null &&
      (n <= DSL_LIMITS.minAtrMultiplierExclusive || n > DSL_LIMITS.maxAtrMultiplier)
    ) {
      out.push(issue(key, `${label} ${n} is outside (0.05, 10]`));
    }
  }
  checkInt(
    out,
    'atrPeriod',
    'ATR period',
    f['atrPeriod'],
    DSL_LIMITS.minPeriod,
    DSL_LIMITS.maxPeriod,
    false,
  );
  if (f['baseConfidence'] !== undefined && f['baseConfidence'] !== null) {
    const n = numeric(f['baseConfidence']);
    if (n === null) out.push(issue('baseConfidence', 'base confidence must be a number'));
    else if (n < 0 || n > 1) {
      out.push(
        issue(
          'baseConfidence',
          `base confidence ${n} is outside [0, 1] — the engine clamps it`,
          'warning',
        ),
      );
    }
  }

  if (!doc.entryRoot) {
    out.push(
      issue(
        'entryConditionsRoot',
        'No entry conditions — a strategy with none would fire on every bar',
      ),
    );
  }

  walkTree(doc, (n, p) => {
    if (p.depth > DSL_LIMITS.maxTreeDepth) {
      out.push(issue(p.nodePath, `Tree depth exceeds ${DSL_LIMITS.maxTreeDepth}`));
      return;
    }
    if (n.raw !== undefined) {
      out.push(
        issue(p.nodePath, 'Not a valid node — it needs an op with children, or a leaf condition'),
      );
      return;
    }
    if (n.op !== null) {
      const op = n.op;
      if (!(LOGIC_OPS as readonly string[]).includes(op)) {
        out.push(issue(p.nodePath, `Unknown operator '${op}' — use And, Or or Not`));
        return;
      }
      if (n.extra && Object.keys(n.extra).some((k) => lower(k) === 'leaf')) {
        out.push(issue(p.nodePath, 'A group must not also carry a leaf condition'));
      }
      const label = op.toUpperCase();
      if (n.children.length === 0) {
        out.push(issue(p.nodePath, `Empty ${label} — add conditions or remove the group`));
      } else if (op === 'Not' && n.children.length !== 1) {
        out.push(
          issue(p.nodePath, 'NOT takes exactly one condition — wrap several in an AND/OR first'),
        );
      } else if (op !== 'Not' && n.children.length < 2) {
        out.push(
          issue(
            p.nodePath,
            `${label} with one condition is rejected by the engine — add another or remove the group`,
          ),
        );
      }
      return;
    }
    if (
      n.extra &&
      Object.entries(n.extra).some(
        ([k, v]) => lower(k) === 'children' && Array.isArray(v) && v.length > 0,
      )
    ) {
      out.push(issue(p.nodePath, 'A leaf must not also have children'));
    }
    if (n.leaf) validateCondition(out, n.leaf, p.condPath, ctx, version, true);
  });

  return out;
}

/** Parses and validates DSL text; JSON errors come back as an issue at path ''. */
export function validateDslJson(
  json: string | null | undefined,
  ctx: DslValidationContext = {},
): DslIssue[] {
  const r = parseDsl(json);
  if (!r.ok) return [issue('', r.error)];
  return validateDsl(r.doc, ctx);
}

// ── Issue paths → tree nodes ────────────────────────────────────────────────

interface PathSegment {
  key: string;
  index: number | null;
}

export function parseIssuePath(path: string): PathSegment[] {
  const segs: PathSegment[] = [];
  const cleaned = (path ?? '').trim().replace(/^\$\.?/, '');
  if (!cleaned) return segs;
  for (const part of cleaned.split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) {
      segs.push({ key: lower(part), index: null });
      continue;
    }
    const indices = [...m[2].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
    if (indices.length === 0) segs.push({ key: lower(m[1]), index: null });
    else {
      segs.push({ key: lower(m[1]), index: indices[0] });
      for (const extraIndex of indices.slice(1)) segs.push({ key: '', index: extraIndex });
    }
  }
  return segs;
}

export interface ResolvedIssueTarget {
  /** The deepest tree node the path reaches, if any. */
  node: DslNode | null;
  tree: 'entry' | 'exit' | null;
  /** Remainder below the node's condition, e.g. `indicatorThreshold.period`. */
  field: string | null;
  /** A top-level scalar field the path names, e.g. `stopLossAtrMultiplier`. */
  topField: string | null;
}

/** Maps an engine-style issue path onto the doc's tree (case-insensitively). */
export function resolveIssuePath(doc: DslDoc, path: string): ResolvedIssueTarget {
  const none: ResolvedIssueTarget = { node: null, tree: null, field: null, topField: null };
  const segs = parseIssuePath(path);
  if (segs.length === 0) return none;
  const head = segs[0];
  const rest = (from: number) =>
    segs
      .slice(from)
      .map((s) => (s.index !== null ? `${s.key}[${s.index}]` : s.key))
      .join('.') || null;

  if (head.key === 'entryconditionsroot' || head.key === 'exitconditionsroot') {
    const tree = head.key === 'entryconditionsroot' ? 'entry' : 'exit';
    let node = tree === 'entry' ? doc.entryRoot : doc.exitRoot;
    if (!node) return { ...none, tree };
    let i = 1;
    while (i < segs.length && segs[i].key === 'children' && segs[i].index !== null) {
      const next: DslNode | undefined = node!.children[segs[i].index!];
      if (!next) break;
      node = next;
      i++;
    }
    const field = i < segs.length && segs[i].key === 'leaf' ? rest(i + 1) : rest(i);
    return { node, tree, field, topField: null };
  }
  if (head.key === 'entryconditions' && doc.entryRoot) {
    const root = doc.entryRoot;
    if (head.index === null) return { node: root, tree: 'entry', field: rest(1), topField: null };
    const node = root.op !== null ? root.children[head.index] : head.index === 0 ? root : undefined;
    return { node: node ?? root, tree: 'entry', field: rest(1), topField: null };
  }
  const top = SCALAR_FIELDS.find((k) => lower(k) === head.key);
  if (top) return { ...none, topField: top };
  return none;
}

export interface IssueIndex {
  byNode: Map<string, DslIssue[]>;
  byTopField: Map<string, DslIssue[]>;
  /** Issues whose path reaches neither a node nor a top-level field. */
  unplaced: DslIssue[];
}

export function indexIssues(doc: DslDoc | null, issues: readonly DslIssue[]): IssueIndex {
  const index: IssueIndex = { byNode: new Map(), byTopField: new Map(), unplaced: [] };
  for (const i of issues) {
    const target = doc ? resolveIssuePath(doc, i.path) : null;
    if (target?.node) {
      const list = index.byNode.get(target.node.uid) ?? [];
      list.push(i);
      index.byNode.set(target.node.uid, list);
    } else if (target?.topField) {
      const list = index.byTopField.get(target.topField) ?? [];
      list.push(i);
      index.byTopField.set(target.topField, list);
    } else {
      index.unplaced.push(i);
    }
  }
  return index;
}

// ── MathExpression syntax (mirror of the engine's MathExpressionParser) ─────

const BAR_FIELDS = ['open', 'high', 'low', 'close'];

/**
 * Checks an expression against the engine's grammar: numbers, `+ - * /`,
 * parentheses, the bar fields Open/High/Low/Close and indicator calls such as
 * `Rsi(14)`. Returns null when it parses, else the error. Unknown indicator
 * names are errors here: the engine parses them but they evaluate to nothing,
 * so the condition would never fire.
 */
export function checkMathExpression(expression: string): string | null {
  type Tok = { kind: 'num' | 'id' | 'op' | '(' | ')' | ','; text: string; pos: number };
  const toks: Tok[] = [];
  for (let i = 0; i < expression.length; ) {
    const ch = expression[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const start = i;
      while (i < expression.length && /[0-9.]/.test(expression[i])) i++;
      toks.push({ kind: 'num', text: expression.slice(start, i), pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < expression.length && /[A-Za-z0-9_]/.test(expression[i])) i++;
      toks.push({ kind: 'id', text: expression.slice(start, i), pos: start });
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      toks.push({ kind: ch, text: ch, pos: i });
      i++;
      continue;
    }
    if ('+-*/'.includes(ch)) {
      toks.push({ kind: 'op', text: ch, pos: i });
      i++;
      continue;
    }
    return `unexpected character '${ch}' at position ${i}`;
  }

  let pos = 0;
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  const expr = (): void => {
    term();
    while (pos < toks.length && toks[pos].kind === 'op' && '+-'.includes(toks[pos].text)) {
      pos++;
      term();
    }
  };
  const term = (): void => {
    factor();
    while (pos < toks.length && toks[pos].kind === 'op' && '*/'.includes(toks[pos].text)) {
      pos++;
      factor();
    }
  };
  const factor = (): void => {
    if (pos >= toks.length) fail('unexpected end of expression');
    const t = toks[pos];
    if (t.kind === 'op' && t.text === '-') {
      pos++;
      factor();
      return;
    }
    if (t.kind === 'num') {
      if (!Number.isFinite(Number(t.text))) fail(`invalid number '${t.text}' at position ${t.pos}`);
      pos++;
      return;
    }
    if (t.kind === '(') {
      pos++;
      expr();
      if (pos >= toks.length || toks[pos].kind !== ')')
        fail(`missing closing ')' near position ${t.pos}`);
      pos++;
      return;
    }
    if (t.kind === 'id') {
      pos++;
      if (pos >= toks.length || toks[pos].kind !== '(') {
        if (!BAR_FIELDS.includes(lower(t.text))) {
          fail(
            `unknown bar field '${t.text}' at position ${t.pos} — use Open/High/Low/Close or an indicator call like Rsi(14)`,
          );
        }
        return;
      }
      if (!indicatorInfo(t.text)) {
        fail(`unknown indicator '${t.text}' at position ${t.pos} — it would never produce a value`);
      }
      pos++;
      if (pos >= toks.length || toks[pos].kind !== 'num') {
        fail(`indicator '${t.text}' needs a numeric period at position ${t.pos}`);
      }
      pos++;
      if (pos >= toks.length || toks[pos].kind !== ')') {
        fail(`indicator '${t.text}' is missing its closing ')' near position ${t.pos}`);
      }
      pos++;
      return;
    }
    fail(`unexpected '${t.text}' at position ${t.pos}`);
  };

  try {
    expr();
    if (pos !== toks.length) return `unexpected '${toks[pos].text}' at position ${toks[pos].pos}`;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Typed schemas for a strategy's five sub-config JSON columns (RiskOverridesJson, SizingConfigJson,
 * SessionFilterJson, RegimeGateJson, MultiTimeframeGateJson) and the parse/serialise round-trip the
 * Strategy form's typed editors use.
 *
 * Mirrors the engine exactly — keep in step with:
 *  - `StrategyConfigParser` (RiskOverridesConfig, SizingConfig + SizingMode, SessionFilterConfig,
 *    RegimeGateConfig, MultiTimeframeGateConfig) — the records each column deserialises into
 *    (case-insensitive property names);
 *  - `StrategySubConfigRules` / `SessionFilterRules` / `RegimeGateRules` /
 *    `MultiTimeframeGateRules` — the save-time validation (mirrored here as advisory problems; the
 *    engine remains the authority and refuses an invalid column on save).
 *
 * Semantics: an unset field is OMITTED from the JSON (= inherit); a blob with nothing left in it
 * serialises to '' (= clear the column). Keys the engine does not read are preserved verbatim in
 * their original position.
 */

export type SubConfigKind = 'riskOverrides' | 'sizing' | 'sessionFilter' | 'regimeGate' | 'mtfGate';

export type SubConfigFieldType = 'enum' | 'decimal' | 'int' | 'triBool' | 'time' | 'multiEnum';

export interface SubConfigOption {
  value: string;
  label: string;
}

/** Values of the known fields, keyed by canonical JSON name. Absent = inherit / not set. */
export type SubConfigValues = Record<string, unknown>;

export interface SubConfigContext {
  /** The strategy's own timeframe — the MTF gate's timeframe must be strictly higher. */
  strategyTimeframe?: string | null;
}

export interface SubConfigField {
  /** Canonical JSON property name (the engine's `[JsonPropertyName]`). */
  key: string;
  type: SubConfigFieldType;
  label: string | ((v: SubConfigValues) => string);
  hint?: string | ((v: SubConfigValues) => string);
  options?: readonly SubConfigOption[] | ((ctx: SubConfigContext) => readonly SubConfigOption[]);
  /** Legacy enum spellings the engine still accepts → canonical value. */
  aliases?: Record<string, string>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** Whether the engine reads this field given the other values (shown regardless when set). */
  relevant?: (v: SubConfigValues) => boolean;
}

export interface SubConfigSchema {
  kind: SubConfigKind;
  title: string;
  fields: readonly SubConfigField[];
  /** Advisory mirror of the engine's save-time validation. */
  problems?: (v: SubConfigValues, ctx: SubConfigContext) => string[];
}

const opts = (...values: string[]): SubConfigOption[] =>
  values.map((v) => ({ value: v, label: v }));

const DISTANCE_MODES: SubConfigOption[] = [
  { value: 'Atr', label: 'ATR multiple' },
  { value: 'Pips', label: 'Pips' },
];

function distanceLabel(what: string, mode: unknown): string {
  if (mode === 'Pips') return `${what} distance (pips)`;
  if (mode === 'Atr') return `${what} distance (× ATR)`;
  return `${what} multiplier`;
}

function distanceHint(mode: unknown): string {
  if (mode === 'Pips') return 'Literal pips from entry.';
  if (mode === 'Atr') return 'Multiple of the ATR at signal generation.';
  return 'Ignored until a mode is chosen.';
}

// ── Risk overrides ───────────────────────────────────────────────────────────
export const RISK_OVERRIDES_SCHEMA: SubConfigSchema = {
  kind: 'riskOverrides',
  title: 'Risk overrides',
  fields: [
    { key: 'slMode', type: 'enum', label: 'Stop-loss mode', options: DISTANCE_MODES },
    {
      key: 'slMultiplier',
      type: 'decimal',
      label: (v) => distanceLabel('Stop-loss', v['slMode']),
      hint: (v) => distanceHint(v['slMode']),
      min: 0,
      step: 0.1,
    },
    { key: 'tpMode', type: 'enum', label: 'Take-profit mode', options: DISTANCE_MODES },
    {
      key: 'tpMultiplier',
      type: 'decimal',
      label: (v) => distanceLabel('Take-profit', v['tpMode']),
      hint: (v) => distanceHint(v['tpMode']),
      min: 0,
      step: 0.1,
    },
    {
      key: 'trailingStopAtrMultiplier',
      type: 'decimal',
      label: 'Trailing stop (× ATR)',
      hint: 'EA tick-driven trailing stop distance.',
      min: 0,
      step: 0.1,
    },
    {
      key: 'trailingStopAtrPeriod',
      type: 'int',
      label: 'Trailing stop ATR period',
      hint: "Bars, on the strategy's timeframe. Blank = 14.",
      min: 1,
      step: 1,
      placeholder: '14',
    },
    {
      key: 'maxOpenPositions',
      type: 'int',
      label: 'Max open positions',
      hint: 'Rule strategies only (clamped 1–100); Pine scripts use their own pyramiding. Blank = 1.',
      min: 1,
      max: 100,
      step: 1,
      placeholder: '1',
    },
  ],
  problems: (v) => {
    const p: string[] = [];
    if (v['slMultiplier'] != null && v['slMode'] == null)
      p.push('Stop-loss multiplier is ignored without a stop-loss mode.');
    if (v['tpMultiplier'] != null && v['tpMode'] == null)
      p.push('Take-profit multiplier is ignored without a take-profit mode.');
    return p;
  },
};

// ── Sizing ───────────────────────────────────────────────────────────────────
const VALUE_MODES = ['FixedLot', 'PercentOfEquity', 'Cash', 'BaseLotMultiplier'];
const RISK_MODES = ['RiskPercentOfEquity', 'AtrBased'];

function sizingValueLabel(mode: unknown): string {
  switch (mode) {
    case 'FixedLot':
      return 'Lots';
    case 'PercentOfEquity':
      return 'Notional (% of equity)';
    case 'Cash':
      return 'Notional (account currency)';
    case 'BaseLotMultiplier':
      return 'Base-lot multiplier';
    default:
      return 'Value';
  }
}

export const SIZING_SCHEMA: SubConfigSchema = {
  kind: 'sizing',
  title: 'Sizing',
  fields: [
    {
      key: 'mode',
      type: 'enum',
      label: 'Sizing mode',
      options: [
        { value: 'FixedLot', label: 'Fixed lot' },
        { value: 'RiskPercentOfEquity', label: 'Risk % of equity (to the stop)' },
        { value: 'PercentOfEquity', label: 'Notional % of equity' },
        { value: 'Cash', label: 'Cash notional' },
        { value: 'AtrBased', label: 'ATR-based risk' },
        { value: 'BaseLotMultiplier', label: 'Base-lot multiplier' },
      ],
      aliases: { percentequity: 'RiskPercentOfEquity', kellyfraction: 'BaseLotMultiplier' },
    },
    {
      key: 'value',
      type: 'decimal',
      label: (v) => sizingValueLabel(v['mode']),
      min: 0,
      step: 0.01,
      relevant: (v) => VALUE_MODES.includes(v['mode'] as string),
    },
    {
      key: 'riskPerTradePct',
      type: 'decimal',
      label: 'Risk per trade (% of equity)',
      hint: 'Percent of equity lost if the stop is hit.',
      min: 0,
      step: 0.1,
      relevant: (v) => RISK_MODES.includes(v['mode'] as string),
    },
    {
      key: 'atrMultiplier',
      type: 'decimal',
      label: 'Stop distance (× ATR)',
      min: 0,
      step: 0.1,
      relevant: (v) => v['mode'] === 'AtrBased',
    },
  ],
  problems: (v) => {
    const p: string[] = [];
    const mode = v['mode'] as string | undefined;
    const anyValue =
      v['value'] != null || v['riskPerTradePct'] != null || v['atrMultiplier'] != null;
    if (!mode && anyValue) p.push('A sizing mode is required when any sizing value is set.');
    if (mode && VALUE_MODES.includes(mode) && v['value'] == null)
      p.push(
        `${sizingValueLabel(mode)} is required for this mode (otherwise the risk profile sizes the trade).`,
      );
    if (mode && RISK_MODES.includes(mode) && v['riskPerTradePct'] == null)
      p.push('Risk per trade is required for this mode.');
    if (mode === 'AtrBased' && v['atrMultiplier'] == null)
      p.push('Stop distance (× ATR) is required for ATR-based sizing.');
    return p;
  },
};

// ── Session filter ───────────────────────────────────────────────────────────
export const SESSION_FILTER_SCHEMA: SubConfigSchema = {
  kind: 'sessionFilter',
  title: 'Session filter',
  fields: [
    {
      key: 'sessionStartUtc',
      type: 'time',
      label: 'Session start (UTC)',
      hint: 'Inclusive. A start after the end wraps midnight.',
    },
    { key: 'sessionEndUtc', type: 'time', label: 'Session end (UTC)', hint: 'Exclusive.' },
    {
      key: 'tradeWeekends',
      type: 'triBool',
      label: 'Weekends',
      hint: 'Off = no signals on Saturday/Sunday (UTC).',
    },
    {
      key: 'newsEmbargoMinutesBefore',
      type: 'int',
      label: 'News embargo before (min)',
      min: 0,
      step: 1,
    },
    {
      key: 'newsEmbargoMinutesAfter',
      type: 'int',
      label: 'News embargo after (min)',
      min: 0,
      step: 1,
    },
  ],
  problems: (v) => {
    const p: string[] = [];
    const s = v['sessionStartUtc'];
    const e = v['sessionEndUtc'];
    if ((s == null) !== (e == null)) p.push('A session window needs both a start and an end.');
    else if (s != null && s === e) p.push('Start equals end — the window would be empty.');
    return p;
  },
};

// ── Regime gate ──────────────────────────────────────────────────────────────
export const MARKET_REGIMES = [
  'Trending',
  'Ranging',
  'HighVolatility',
  'LowVolatility',
  'Crisis',
  'Breakout',
] as const;

export const REGIME_GATE_SCHEMA: SubConfigSchema = {
  kind: 'regimeGate',
  title: 'Regime gate',
  fields: [
    {
      key: 'allowedRegimes',
      type: 'multiEnum',
      label: 'Allowed regimes',
      hint: 'Signals fire only in the ticked regimes. None ticked = no gate.',
      options: opts(...MARKET_REGIMES),
    },
  ],
};

// ── Multi-timeframe gate ─────────────────────────────────────────────────────
export const GATE_TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const;
const MTF_MAX_PERIOD = 500;

function higherTimeframes(ctx: SubConfigContext): SubConfigOption[] {
  const idx = ctx.strategyTimeframe
    ? GATE_TIMEFRAMES.indexOf(ctx.strategyTimeframe as (typeof GATE_TIMEFRAMES)[number])
    : -1;
  return opts(...GATE_TIMEFRAMES.slice(idx + 1));
}

export const MTF_GATE_SCHEMA: SubConfigSchema = {
  kind: 'mtfGate',
  title: 'Multi-timeframe gate',
  fields: [
    {
      key: 'timeframe',
      type: 'enum',
      label: 'Higher timeframe',
      hint: "Must be above the strategy's own timeframe.",
      options: higherTimeframes,
    },
    {
      key: 'indicator',
      type: 'enum',
      label: 'Indicator',
      options: [
        { value: 'SMA', label: 'SMA' },
        { value: 'EMA', label: 'EMA' },
        { value: 'WMA', label: 'WMA' },
      ],
    },
    { key: 'period', type: 'int', label: 'Period', min: 1, max: MTF_MAX_PERIOD, step: 1 },
    {
      key: 'comparator',
      type: 'enum',
      label: 'Condition',
      options: [
        { value: 'PriceAbove', label: 'Price above' },
        { value: 'PriceBelow', label: 'Price below' },
        { value: 'Crossover', label: 'Crossover (price crosses up)' },
        { value: 'Crossunder', label: 'Crossunder (price crosses down)' },
      ],
    },
  ],
  problems: (v, ctx) => {
    const keys = ['timeframe', 'indicator', 'period', 'comparator'];
    if (keys.every((k) => v[k] == null)) return [];
    const p: string[] = [];
    const missing = keys.filter((k) => v[k] == null);
    if (missing.length > 0)
      p.push(
        `The gate needs all four fields — missing: ${missing.join(', ')}. (An incomplete gate blocks every signal.)`,
      );
    const tf = v['timeframe'];
    if (tf != null && ctx.strategyTimeframe && !higherTimeframes(ctx).some((o) => o.value === tf))
      p.push(`${tf} is not higher than the strategy's timeframe ${ctx.strategyTimeframe}.`);
    const period = v['period'];
    if (typeof period === 'number' && (period < 1 || period > MTF_MAX_PERIOD))
      p.push(`Period must be 1–${MTF_MAX_PERIOD}.`);
    return p;
  },
};

export const SUB_CONFIG_SCHEMAS: Record<SubConfigKind, SubConfigSchema> = {
  riskOverrides: RISK_OVERRIDES_SCHEMA,
  sizing: SIZING_SCHEMA,
  sessionFilter: SESSION_FILTER_SCHEMA,
  regimeGate: REGIME_GATE_SCHEMA,
  mtfGate: MTF_GATE_SCHEMA,
};

// ── Parse / serialise ────────────────────────────────────────────────────────

export interface ParsedSubConfig {
  /** Known fields, canonical keys, canonical enum spellings. */
  values: SubConfigValues;
  /** The stored object (null when blank) — its key order and unknown keys are preserved on save. */
  source: Record<string, unknown> | null;
  /** Keys the engine does not read (preserved verbatim). */
  unknownKeys: string[];
  /** Known keys whose stored value the form cannot represent (preserved verbatim until edited). */
  unrepresentable: string[];
  /** Set when the raw text is not a JSON object; the typed form cannot be used. */
  error: string | null;
}

export function fieldOptions(
  field: SubConfigField,
  ctx: SubConfigContext,
): readonly SubConfigOption[] {
  return typeof field.options === 'function' ? field.options(ctx) : (field.options ?? []);
}

function findField(schema: SubConfigSchema, key: string): SubConfigField | undefined {
  const k = key.toLowerCase();
  return schema.fields.find((f) => f.key.toLowerCase() === k);
}

/** Every option a field can ever offer (MTF timeframes regardless of the strategy's own). */
function allOptions(field: SubConfigField): readonly SubConfigOption[] {
  if (field.key === 'timeframe' && typeof field.options === 'function')
    return opts(...GATE_TIMEFRAMES);
  return fieldOptions(field, {});
}

function canonicalEnum(field: SubConfigField, raw: string): string | undefined {
  const t = raw.trim().toLowerCase();
  const hit = allOptions(field).find((o) => o.value.toLowerCase() === t);
  if (hit) return hit.value;
  return field.aliases?.[t];
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Coerces a stored value into the form's representation; undefined when it cannot. */
function coerce(field: SubConfigField, raw: unknown): unknown {
  if (raw === null || raw === undefined) return undefined;
  switch (field.type) {
    case 'enum':
      return typeof raw === 'string' ? canonicalEnum(field, raw) : undefined;
    case 'decimal':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
    case 'int':
      return typeof raw === 'number' && Number.isInteger(raw) ? raw : undefined;
    case 'triBool':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'time':
      return typeof raw === 'string' && TIME_RE.test(raw.trim()) ? raw.trim() : undefined;
    case 'multiEnum': {
      if (!Array.isArray(raw)) return undefined;
      const out: string[] = [];
      for (const r of raw) {
        const c = typeof r === 'string' ? canonicalEnum(field, r) : undefined;
        if (c === undefined) return undefined;
        if (!out.includes(c)) out.push(c);
      }
      return out;
    }
  }
}

export function parseSubConfig(
  raw: string | null | undefined,
  schema: SubConfigSchema,
): ParsedSubConfig {
  const empty: ParsedSubConfig = {
    values: {},
    source: null,
    unknownKeys: [],
    unrepresentable: [],
    error: null,
  };
  const text = (raw ?? '').trim();
  if (!text || text === 'null') return empty;

  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ...empty, error: `Not valid JSON: ${(e as Error).message}` };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj))
    return { ...empty, error: 'Must be a JSON object ({ … }).' };

  const source = obj as Record<string, unknown>;
  const values: SubConfigValues = {};
  const unknownKeys: string[] = [];
  const unrepresentable: string[] = [];
  for (const [k, v] of Object.entries(source)) {
    const field = findField(schema, k);
    if (!field) {
      unknownKeys.push(k);
      continue;
    }
    if (v === null) continue;
    const c = coerce(field, v);
    if (c === undefined) unrepresentable.push(k);
    else values[field.key] = c;
  }
  return { values, source, unknownKeys, unrepresentable, error: null };
}

function isUnset(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/**
 * Writes `values` back over `source`: known keys are replaced in place under their canonical
 * name (or removed when unset), unknown keys and unrepresentable values the operator did not
 * touch stay as they were, new keys append in schema order. Nothing left → '' (clear the column).
 */
export function serializeSubConfig(
  schema: SubConfigSchema,
  values: SubConfigValues,
  source: Record<string, unknown> | null,
  /** Known keys the form could not represent and the operator has not edited — kept verbatim. */
  keepRaw: readonly string[] = [],
): string {
  const out: Record<string, unknown> = {};
  const written = new Set<string>();
  const keep = new Set(keepRaw.map((k) => k.toLowerCase()));

  for (const [k, v] of Object.entries(source ?? {})) {
    const field = findField(schema, k);
    if (!field) {
      out[k] = v;
      continue;
    }
    if (written.has(field.key)) continue; // a case-variant duplicate collapses into one key
    written.add(field.key);
    const next = values[field.key];
    if (!isUnset(next)) out[field.key] = next;
    else if (keep.has(k.toLowerCase()) && v !== null) out[k] = v;
  }
  for (const f of schema.fields) {
    if (written.has(f.key)) continue;
    const next = values[f.key];
    if (!isUnset(next)) out[f.key] = next;
  }
  return Object.keys(out).length === 0 ? '' : JSON.stringify(out);
}

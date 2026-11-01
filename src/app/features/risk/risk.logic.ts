import type { EChartsOption } from 'echarts';

import type {
  MarginForecastStatus,
  NettedCurrencyExposure,
  PortfolioRiskPoint,
  RiskJob,
  RiskSetting,
  ScenarioType,
  StepVerdict,
  StressMode,
  StressResult,
  StressShockDefinition,
} from './risk.types';

/** Chip tone used across the page. */
export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export function modeTone(mode: StressMode | string): Tone {
  return mode === 'Enforce' ? 'ok' : mode === 'Observe' ? 'warn' : 'muted';
}

export function modeExplainer(mode: StressMode | string): string {
  switch (mode) {
    case 'Enforce':
      return 'Enforce: trades whose post-trade stress loss or stop-out distance break the limits are rejected or cut down.';
    case 'Off':
      return 'Off: the stress pre-trade check does not run.';
    default:
      return 'Observe: the check records what it would have done and never blocks or resizes a trade.';
  }
}

export function forecastTone(status: MarginForecastStatus | string | null | undefined): Tone {
  switch (status) {
    case 'AtStopOut':
    case 'AtMarginCall':
      return 'bad';
    case 'WithinAlertBuffer':
      return 'warn';
    case 'Ok':
      return 'ok';
    default:
      return 'muted';
  }
}

export function forecastLabel(status: MarginForecastStatus | string | null | undefined): string {
  switch (status) {
    case 'AtStopOut':
      return 'At stop-out';
    case 'AtMarginCall':
      return 'At margin call';
    case 'WithinAlertBuffer':
      return 'Close to stop-out';
    case 'Ok':
      return 'Healthy';
    case 'Flat':
      return 'No open positions';
    case 'NoStopOutLevel':
      return 'No broker stop-out level';
    default:
      return '—';
  }
}

export function verdictTone(v: StepVerdict | string): Tone {
  if (v === 'Pass') return 'ok';
  if (v === 'Reject' || v === 'Rejected') return 'bad';
  return 'warn';
}

export function verdictLabel(v: StepVerdict | string): string {
  switch (v) {
    case 'Pass':
      return 'Passes';
    case 'WouldReject':
      return 'Would reject (Observe)';
    case 'WouldShrink':
      return 'Would cut the size (Observe)';
    case 'Reject':
    case 'Rejected':
      return 'Rejected';
    case 'Shrink':
    case 'Shrunk':
      return 'Size cut';
    default:
      return v;
  }
}

/** A stress result is a breach when it reaches a margin call, a stop-out or the drawdown limit. */
export function isBreach(r: Pick<StressResult, 'wouldTriggerMarginCall' | 'wouldTriggerStopOut' | 'wouldBreachDrawdownLimit'>): boolean {
  return r.wouldTriggerMarginCall || r.wouldTriggerStopOut || r.wouldBreachDrawdownLimit;
}

export function breachLabels(r: StressResult): string[] {
  const out: string[] = [];
  if (r.wouldTriggerStopOut) out.push('Stop-out');
  else if (r.wouldTriggerMarginCall) out.push('Margin call');
  if (r.wouldBreachDrawdownLimit) out.push('Drawdown limit');
  return out;
}

export function formatMoney(value: number | null | undefined, currency = 'USD', digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** VaR history chart: VaR95, VaR99, CVaR95 and stressed VaR over time. */
export function varHistoryOption(points: PortfolioRiskPoint[], currency: string): EChartsOption {
  const rows = points.filter((p) => p.status === 'Computed' || p.status === 'NoPositions');
  const series = (name: string, pick: (p: PortfolioRiskPoint) => number, color: string, dashed = false) => ({
    name,
    type: 'line' as const,
    showSymbol: false,
    smooth: false,
    lineStyle: { width: 2, color, type: dashed ? ('dashed' as const) : ('solid' as const) },
    itemStyle: { color },
    data: rows.map((p) => [p.computedAtUtc, pick(p)]),
  });
  return {
    grid: { left: 64, right: 16, top: 32, bottom: 40 },
    legend: { top: 0 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => formatMoney(Number(v), currency) },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', name: currency, axisLabel: { formatter: (v: number) => formatNumber(v, 0) } },
    series: [
      series('VaR 95%', (p) => p.vaR95, '#0A84FF'),
      series('VaR 99%', (p) => p.vaR99, '#AF52DE'),
      series('CVaR 95%', (p) => p.cVaR95, '#FF9500', true),
      series('Stressed VaR', (p) => p.stressedVaR, '#FF3B30', true),
    ],
  };
}

/** Exposure bars: positions + working orders (committed) and the live signals on top, per currency leg. */
export function exposureOption(rows: NettedCurrencyExposure[], currency: string, includeSignals: boolean): EChartsOption {
  const top = [...rows].sort((a, b) => Math.abs(b.withSignals) - Math.abs(a.withSignals)).slice(0, 16);
  return {
    grid: { left: 72, right: 16, top: 32, bottom: 40 },
    legend: { top: 0 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => formatMoney(Number(v), currency) },
    xAxis: { type: 'category', data: top.map((r) => r.currency) },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => formatNumber(v / 1000, 0) + 'k' } },
    series: [
      { name: 'Positions', type: 'bar', stack: 'net', itemStyle: { color: '#0A84FF' }, data: top.map((r) => r.positions) },
      { name: 'Working orders', type: 'bar', stack: 'net', itemStyle: { color: '#5AC8FA' }, data: top.map((r) => r.pendingOrders) },
      ...(includeSignals
        ? [{ name: 'Live signals', type: 'bar' as const, stack: 'net', itemStyle: { color: '#FFCC00' }, data: top.map((r) => r.signals) }]
        : []),
    ],
  };
}

// ── Settings controls ────────────────────────────────────────────────────────

/** Validation of a typed control's raw value; null = valid. */
export function settingError(s: RiskSetting, raw: string): string | null {
  const v = raw.trim();
  if (s.kind === 'Bool') return v === 'true' || v === 'false' ? null : 'Choose on or off.';
  if (s.kind === 'Enum') return s.allowedValues.includes(v) ? null : `Choose one of ${s.allowedValues.join(', ')}.`;
  if (v === '' || !Number.isFinite(Number(v))) return 'Enter a number.';
  const n = Number(v);
  if (s.kind === 'Int' && !Number.isInteger(n)) return 'Enter a whole number.';
  if (s.min !== null && n < s.min) return `At least ${s.min}.`;
  if (s.max !== null && n > s.max) return `At most ${s.max}.`;
  return null;
}

/**
 * Is `next` looser than `current` for this setting? Mode: Enforce (tightest) > Observe > Off. Max scenario loss: higher
 * is looser. Min stop-out σ: lower is looser. Everything else is not a risk limit (null = not judged). The engine
 * makes the final call (cooling-off / two-person); this only lets the page warn before sending.
 */
export function isLoosening(s: RiskSetting, current: string, next: string): boolean | null {
  if (s.key === 'Risk:Stress:Mode') {
    const order = ['Enforce', 'Observe', 'Off'];
    return order.indexOf(next) > order.indexOf(current);
  }
  if (s.key === 'Risk:Stress:MaxScenarioLossPct') return Number(next) > Number(current);
  if (s.key === 'Risk:Margin:MinStopOutSigma') return Number(next) < Number(current);
  return null;
}

/** An organisation value of a tighten-only key must be tighter than (or equal to) what it inherits. */
export function organisationValueAllowed(s: RiskSetting, next: string): boolean {
  if (!s.tightenOnly) return true;
  const inherited = s.platformValue ?? s.defaultValue;
  return isLoosening(s, inherited, next) !== true;
}

export function groupSettings(settings: RiskSetting[]): { group: string; items: RiskSetting[] }[] {
  const groups: { group: string; items: RiskSetting[] }[] = [];
  for (const s of settings) {
    let g = groups.find((x) => x.group === s.group);
    if (!g) groups.push((g = { group: s.group, items: [] }));
    g.items.push(s);
  }
  return groups;
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export function jobTone(job: RiskJob, nowMs = Date.now()): Tone {
  if (!job.enabled) return 'muted';
  if (job.consecutiveFailures > 0) return 'bad';
  if (job.nextRunAtUtc && Date.parse(job.nextRunAtUtc) < nowMs - 10 * 60_000) return 'warn'; // overdue by > 10 min
  return 'ok';
}

// ── Scenario editor ─────────────────────────────────────────────────────────

export interface ShockRow {
  kind: 'currency' | 'symbol' | 'assetClass';
  key: string;
  pctChange: number | null;
}

export interface ScenarioForm {
  name: string;
  scenarioType: ScenarioType;
  dateFrom: string;
  dateTo: string;
  targetLossPct: number | null;
  rows: ShockRow[];
  description: string;
  source: string;
  isActive: boolean;
}

export function emptyScenarioForm(): ScenarioForm {
  return {
    name: '',
    scenarioType: 'Hypothetical',
    dateFrom: '',
    dateTo: '',
    targetLossPct: 25,
    rows: [{ kind: 'currency', key: 'USD', pctChange: 3 }],
    description: '',
    source: '',
    isActive: true,
  };
}

export function formFromDefinition(name: string, type: ScenarioType, d: StressShockDefinition, extra: Partial<ScenarioForm> = {}): ScenarioForm {
  return {
    ...emptyScenarioForm(),
    name,
    scenarioType: type,
    dateFrom: d.dateFrom ? d.dateFrom.slice(0, 10) : '',
    dateTo: d.dateTo ? d.dateTo.slice(0, 10) : '',
    targetLossPct: d.targetLossPct ?? 25,
    rows: [
      ...d.currencyShocks.map((c) => ({ kind: 'currency' as const, key: c.currency, pctChange: c.pctChange })),
      ...d.symbolShocks.map((s) => ({ kind: 'symbol' as const, key: s.symbol, pctChange: s.pctChange })),
      ...d.assetClassShocks.map((a) => ({ kind: 'assetClass' as const, key: a.assetClass, pctChange: a.pctChange })),
    ],
    ...extra,
  };
}

/** The definition JSON the engine stores; problems are reported in the engine's own words on save. */
export function definitionJson(f: ScenarioForm): string {
  const rows = f.rows.filter((r) => r.key.trim() !== '' && r.pctChange !== null && Number.isFinite(r.pctChange));
  const def: Record<string, unknown> = {};
  if (f.scenarioType === 'Historical') {
    def['dateFrom'] = f.dateFrom || null;
    def['dateTo'] = f.dateTo || null;
  }
  if (f.scenarioType === 'ReverseStress') def['targetLossPct'] = f.targetLossPct;
  const pick = (kind: ShockRow['kind']) => rows.filter((r) => r.kind === kind);
  if (f.scenarioType !== 'ReverseStress') {
    def['currencyShocks'] = pick('currency').map((r) => ({ currency: r.key.trim().toUpperCase(), pctChange: r.pctChange }));
    def['symbolShocks'] = pick('symbol').map((r) => ({ symbol: r.key.trim().toUpperCase(), pctChange: r.pctChange }));
    def['assetClassShocks'] = pick('assetClass').map((r) => ({ assetClass: r.key.trim(), pctChange: r.pctChange }));
  }
  return JSON.stringify(def);
}

/** Client-side checks the editor shows before saving (the engine validates again). */
export function scenarioFormProblems(f: ScenarioForm): string[] {
  const out: string[] = [];
  if (!f.name.trim()) out.push('Give the scenario a name.');
  if (f.scenarioType === 'Historical' && (!f.dateFrom || !f.dateTo || f.dateFrom > f.dateTo)) out.push('A historical scenario needs a from date on or before its to date.');
  if (f.scenarioType === 'ReverseStress' && !(f.targetLossPct !== null && f.targetLossPct > 0 && f.targetLossPct < 100))
    out.push('The target loss must be between 0 and 100 % of equity.');
  if (f.scenarioType === 'Hypothetical' && !f.rows.some((r) => r.key.trim() && r.pctChange !== null)) out.push('Add at least one shock.');
  for (const r of f.rows) if (r.pctChange !== null && Math.abs(r.pctChange) > 95) out.push(`${r.key || 'A shock'} is beyond ±95 %.`);
  return out;
}

/** Parse a stress decision's context JSON for display (null when absent or malformed). */
export function decisionContext(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

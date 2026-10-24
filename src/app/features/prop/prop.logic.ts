import type { EChartsOption } from 'echarts';

import type {
  PropBreach,
  PropDashboard,
  PropEnrollmentState,
  PropPhaseKind,
  PropPhaseRules,
  PropProgramRules,
  PropRuleKind,
  PropRuleMetrics,
} from './prop.types';

// ── Defaults ──────────────────────────────────────────────────────────────────────────────────────

/** A phase with no limits set (the editor fills in what the firm wants). */
export function newPhase(kind: PropPhaseKind, name?: string): PropPhaseRules {
  return {
    name: name ?? kind,
    kind,
    profitTargetPct: kind === 'Funded' ? null : 10,
    profitTargetRequiresFlat: true,
    maxDailyLossPct: 5,
    dailyLossReference: 'StartOfDayBalance',
    dailyLossAmountOf: 'InitialBalance',
    maxOverallDrawdownPct: 10,
    drawdownMode: 'Static',
    trailingBasis: 'Equity',
    trailingLocksAtInitialBalance: false,
    minTradingDays: kind === 'Funded' ? null : 4,
    maxLotsPerPosition: null,
    maxTotalOpenLots: null,
    lotsAction: 'Fail',
    newsTradingAllowed: true,
    newsWindowMinutes: 2,
    newsAction: 'Fail',
    weekendHoldingAllowed: true,
    weekend: { startDay: 'Friday', startTime: '16:55', endDay: 'Sunday', endTime: '17:00' },
    weekendAction: 'Fail',
    consistencyMaxBestDayPct: null,
    timeLimitDays: kind === 'Funded' ? null : 30,
  };
}

/** The usual two-step challenge: evaluation 10%, verification 5%, funded 80/20, New York 17:00 day. */
export function defaultRules(): PropProgramRules {
  const verification = newPhase('Verification');
  verification.profitTargetPct = 5;
  verification.timeLimitDays = 60;
  return {
    phases: [newPhase('Evaluation'), verification, newPhase('Funded')],
    tradingDay: { resetTime: '17:00', timeZone: 'America/New_York' },
    profitSplit: { traderSharePct: 80 },
    haltOnBreach: true,
    haltOnPass: false,
  };
}

/** A deep copy the editor may change freely. */
export function cloneRules(rules: PropProgramRules): PropProgramRules {
  return JSON.parse(JSON.stringify(rules)) as PropProgramRules;
}

// ── Validation (mirrors the engine's PropRuleValidation; the engine has the last word) ────────────

const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;

export function ruleErrors(rules: PropProgramRules): string[] {
  const out: string[] = [];
  if (!rules.phases.length) out.push('Add at least one phase.');
  if (!TIME.test(rules.tradingDay.resetTime)) out.push('The daily reset time must be HH:mm.');
  if (!rules.tradingDay.timeZone.trim()) out.push('Give the time zone (e.g. America/New_York).');
  const split = rules.profitSplit.traderSharePct;
  if (!(split >= 0 && split <= 100)) out.push("The trader's profit share must be 0–100%.");
  let funded = false;
  rules.phases.forEach((p, i) => {
    const label = p.name.trim() || `Phase ${i + 1}`;
    if (!p.name.trim()) out.push(`Phase ${i + 1} needs a name.`);
    if (funded) out.push(`${label}: the funded phase must be the last phase.`);
    if (p.kind === 'Funded') funded = true;
    else if (!(p.profitTargetPct !== null && p.profitTargetPct > 0))
      out.push(`${label}: needs a profit target above 0%.`);
    pctCheck(out, label, 'maximum daily loss', p.maxDailyLossPct, 100);
    pctCheck(out, label, 'maximum overall drawdown', p.maxOverallDrawdownPct, 100);
    pctCheck(out, label, 'consistency best-day share', p.consistencyMaxBestDayPct, 100);
    if (p.timeLimitDays !== null && !(p.timeLimitDays >= 1 && p.timeLimitDays <= 3650))
      out.push(`${label}: the time limit must be 1–3650 days.`);
    if (p.minTradingDays !== null && !(p.minTradingDays >= 0 && p.minTradingDays <= 365))
      out.push(`${label}: minimum trading days must be 0–365.`);
    if (
      !p.weekendHoldingAllowed &&
      (!TIME.test(p.weekend.startTime) || !TIME.test(p.weekend.endTime))
    )
      out.push(`${label}: the weekend window times must be HH:mm.`);
  });
  return out;
}

function pctCheck(out: string[], label: string, what: string, v: number | null, max: number): void {
  if (v !== null && !(v > 0 && v <= max))
    out.push(`${label}: the ${what} must be above 0 and at most ${max}%.`);
}

/** An editor number box: '' or null = not set; anything else as a number (NaN when not one). */
export function optionalNumber(text: string | number | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const s = String(text).trim();
  return s === '' ? null : Number(s);
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────

const RULE_LABELS: Record<PropRuleKind, string> = {
  ProfitTarget: 'Profit target',
  MaxDailyLoss: 'Daily loss limit',
  MaxOverallDrawdown: 'Overall drawdown',
  MinTradingDays: 'Minimum trading days',
  MaxPositionLots: 'Position size',
  MaxTotalOpenLots: 'Total open lots',
  NewsTrading: 'News trading',
  WeekendHolding: 'Weekend holding',
  Consistency: 'Consistency',
  TimeLimit: 'Time limit',
};

export function ruleLabel(rule: PropRuleKind | null | undefined): string {
  return rule ? (RULE_LABELS[rule] ?? rule) : '—';
}

/** The chip class of an enrolment state. */
export function stateClass(state: PropEnrollmentState): 'ok' | 'bad' | 'info' | 'warn' | '' {
  switch (state) {
    case 'Passed':
    case 'Funded':
      return 'ok';
    case 'Failed':
      return 'bad';
    case 'Active':
      return 'info';
    default:
      return '';
  }
}

export function money(v: number | null | undefined, currency = ''): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const s = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${s} ${currency}` : s;
}

export function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v.toFixed(digits)}%`;
}

/** One line per rule the phase sets, in plain words. */
export function phaseSummary(p: PropPhaseRules): string[] {
  const lines: string[] = [];
  if (p.kind !== 'Funded' && p.profitTargetPct !== null)
    lines.push(`Profit target ${p.profitTargetPct}%${p.profitTargetRequiresFlat ? ' (flat)' : ''}`);
  if (p.maxDailyLossPct !== null) {
    const ref =
      p.dailyLossReference === 'StartOfDayEquity'
        ? 'day-start equity'
        : p.dailyLossReference === 'HigherOfBalanceAndEquity'
          ? 'higher of day-start balance/equity'
          : 'day-start balance';
    const of = p.dailyLossAmountOf === 'InitialBalance' ? 'initial balance' : 'the day reference';
    lines.push(`Daily loss ≤ ${p.maxDailyLossPct}% of ${of}, from ${ref}`);
  }
  if (p.maxOverallDrawdownPct !== null)
    lines.push(
      p.drawdownMode === 'Trailing'
        ? `Trailing drawdown ${p.maxOverallDrawdownPct}% (${p.trailingBasis.toLowerCase()}${p.trailingLocksAtInitialBalance ? ', locks at initial balance' : ''})`
        : `Max drawdown ${p.maxOverallDrawdownPct}% (static)`,
    );
  if (p.minTradingDays) lines.push(`At least ${p.minTradingDays} trading days`);
  if (p.maxLotsPerPosition !== null)
    lines.push(
      `≤ ${p.maxLotsPerPosition} lots per position${p.lotsAction === 'Warn' ? ' (warn)' : ''}`,
    );
  if (p.maxTotalOpenLots !== null)
    lines.push(
      `≤ ${p.maxTotalOpenLots} lots open in total${p.lotsAction === 'Warn' ? ' (warn)' : ''}`,
    );
  if (!p.newsTradingAllowed)
    lines.push(
      `No trading ±${p.newsWindowMinutes} min of high-impact news${p.newsAction === 'Warn' ? ' (warn)' : ''}`,
    );
  if (!p.weekendHoldingAllowed)
    lines.push(`No weekend holding${p.weekendAction === 'Warn' ? ' (warn)' : ''}`);
  if (p.consistencyMaxBestDayPct !== null)
    lines.push(`Best day ≤ ${p.consistencyMaxBestDayPct}% of profit`);
  if (p.kind !== 'Funded' && p.timeLimitDays !== null)
    lines.push(`${p.timeLimitDays} day time limit`);
  return lines;
}

/** The dashboard's headline figures in words. */
export function limitTiles(
  m: PropRuleMetrics,
): { label: string; value: string; hint: string; tone: 'ok' | 'warn' | 'bad' | '' }[] {
  const tiles: { label: string; value: string; hint: string; tone: 'ok' | 'warn' | 'bad' | '' }[] =
    [];
  tiles.push({
    label: 'Profit',
    value: pct(m.profitPct),
    hint:
      m.profitTargetPct !== null
        ? `target ${pct(m.profitTargetPct, 1)} → ${money(m.profitTargetBalance)}`
        : 'funded — no target',
    tone: m.profitTargetMet ? 'ok' : '',
  });
  if (m.dailyLossLimit !== null && m.dailyLossRemaining !== null) {
    const used = m.dailyLossLimit > 0 ? ((m.dailyLossUsed ?? 0) / m.dailyLossLimit) * 100 : 0;
    tiles.push({
      label: 'Daily loss left',
      value: money(Math.max(0, m.dailyLossRemaining)),
      hint: `${used.toFixed(0)}% of ${money(m.dailyLossLimit)} used · floor ${money(m.dailyLossFloor)}`,
      tone: used >= 80 ? 'bad' : used >= 50 ? 'warn' : 'ok',
    });
  }
  if (m.drawdownLimit !== null && m.drawdownRemaining !== null) {
    const used = m.drawdownLimit > 0 ? (1 - m.drawdownRemaining / m.drawdownLimit) * 100 : 0;
    tiles.push({
      label: 'Distance to drawdown limit',
      value: money(Math.max(0, m.drawdownRemaining)),
      hint: `floor ${money(m.drawdownFloor)} · ${Math.max(0, used).toFixed(0)}% of the allowance used`,
      tone: used >= 80 ? 'bad' : used >= 50 ? 'warn' : 'ok',
    });
  }
  tiles.push({
    label: 'Trading days',
    value: String(m.tradingDays),
    hint: m.minTradingDays ? `${m.minTradingDays} needed` : 'no minimum',
    tone: m.minTradingDays && m.tradingDays >= m.minTradingDays ? 'ok' : '',
  });
  if (m.consistencyMaxBestDayPct !== null) {
    tiles.push({
      label: 'Consistency (best day share)',
      value: pct(m.bestDaySharePct, 1),
      hint: `at most ${pct(m.consistencyMaxBestDayPct, 0)} of total profit`,
      tone: m.consistencyMet ? 'ok' : 'warn',
    });
  }
  return tiles;
}

// ── Breach feed ───────────────────────────────────────────────────────────────────────────────────

/** New events on top (newest first), no duplicates, at most `max`. */
export function mergeFeed(current: PropBreach[], incoming: PropBreach[], max = 200): PropBreach[] {
  const seen = new Set(current.map((b) => b.id));
  const fresh = incoming.filter((b) => !seen.has(b.id));
  return [...fresh, ...current].sort((a, b) => b.id - a.id).slice(0, max);
}

/** The highest id seen (the next poll's `afterId`). */
export function lastId(feed: PropBreach[]): number | null {
  return feed.length ? Math.max(...feed.map((b) => b.id)) : null;
}

// ── Dates ─────────────────────────────────────────────────────────────────────────────────────────

/** A date input's `YYYY-MM-DD` as that day's 00:00 UTC (ISO); null when empty or invalid. */
export function dayStartUtc(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Chart ─────────────────────────────────────────────────────────────────────────────────────────

/** The equity curve with the rule lines (overall floor, daily floor, profit target) at each point. */
export function curveOption(d: PropDashboard, dark: boolean): EChartsOption {
  const text = dark ? '#c7c7cc' : '#3a3a3c';
  const grid = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const at = (s: string) => new Date(s).getTime();
  const series = (
    name: string,
    pick: (p: (typeof d.curve)[number]) => number | null,
    color: string,
    dashed = false,
  ) => ({
    name,
    type: 'line' as const,
    showSymbol: false,
    step: dashed ? ('end' as const) : undefined,
    lineStyle: {
      width: dashed ? 1.5 : 2,
      type: dashed ? ('dashed' as const) : ('solid' as const),
      color,
    },
    itemStyle: { color },
    data: d.curve.filter((p) => pick(p) !== null).map((p) => [at(p.atUtc), pick(p)]),
  });
  const lines = [
    series('Equity', (p) => p.equity, '#0a84ff'),
    series('Balance', (p) => p.balance, dark ? '#8e8e93' : '#636366'),
  ];
  if (d.curve.some((p) => p.drawdownFloor !== null))
    lines.push(series('Drawdown floor', (p) => p.drawdownFloor, '#ff3b30', true));
  if (d.curve.some((p) => p.dailyLossFloor !== null))
    lines.push(series('Daily loss floor', (p) => p.dailyLossFloor, '#ff9500', true));
  if (d.curve.some((p) => p.profitTarget !== null))
    lines.push(series('Profit target', (p) => p.profitTarget, '#34c759', true));
  return {
    animation: false,
    grid: { left: 64, right: 16, top: 36, bottom: 32 },
    legend: { top: 0, textStyle: { color: text } },
    tooltip: { trigger: 'axis', valueFormatter: (v) => money(Number(v)) },
    xAxis: { type: 'time', axisLabel: { color: text }, splitLine: { show: false } },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { color: text },
      splitLine: { lineStyle: { color: grid } },
    },
    series: lines,
  };
}

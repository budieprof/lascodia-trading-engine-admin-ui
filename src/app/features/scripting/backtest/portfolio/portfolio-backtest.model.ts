import type { EChartsOption } from 'echarts';

import { withAlpha, type ReportPalette } from '../../report/report-charts';
import { formatDateTime, formatMoney, formatNumber, formatPercent } from '../../report/report-format';
import type {
  PortfolioExposurePoint,
  PortfolioMarginDay,
  PortfolioRefusal,
  PortfolioRefusalKind,
  PortfolioResult,
  PortfolioRunStatus,
  PortfolioTrade,
  QueuePortfolioBacktestRequest,
} from './portfolio-backtest.types';

/**
 * The portfolio backtest pages' logic — the new-run form, its checks and request, and the result charts — as pure
 * functions of the engine's numbers, so it is tested without a DOM. Nothing here estimates: every number drawn is one the
 * engine reported.
 */

export const PORTFOLIO_TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const;

/** The engine's ceiling on members (its configured limit, `PortfolioBacktest:MaxMembers`, may be lower and is enforced there). */
export const MAX_PORTFOLIO_MEMBERS = 20;

export type MemberSourceKind = 'strategy' | 'source';

/** One member in the new-run form. */
export interface MemberDraft {
  uid: number;
  kind: MemberSourceKind;
  strategyId: number | null;
  pineSource: string;
  name: string;
  /** Empty = the strategy's own symbol (required for written source). */
  symbol: string;
  /** Empty = the strategy's own timeframe (required for written source). */
  timeframe: string;
  /** Null = 100 %. */
  equitySharePct: number | null;
  /** Input overrides keyed by input id; empty = the script's own inputs. */
  inputs: Record<string, unknown>;
}

export type LimitsSource = 'default' | 'account' | 'profile';

/** The new-run form. */
export interface PortfolioDraft {
  name: string;
  /** `YYYY-MM-DD`, UTC. */
  fromDate: string;
  toDate: string;
  /** Null = the engine's default script capital. */
  initialBalance: number | null;
  /** Empty = the engine's account currency. */
  accountCurrency: string;
  /** Null = each script's own margin. */
  leverage: number | null;
  barMagnifier: 'script' | 'on' | 'off';
  limitsFrom: LimitsSource;
  tradingAccountId: number | null;
  riskProfileId: number | null;
  /** Null = the profile's own limit; 0 = no limit. */
  legsOverride: number | null;
  correlatedOverride: number | null;
  members: MemberDraft[];
}

let nextUid = 1;

export function newMember(kind: MemberSourceKind = 'strategy'): MemberDraft {
  return {
    uid: nextUid++,
    kind,
    strategyId: null,
    pineSource: '',
    name: '',
    symbol: '',
    timeframe: kind === 'source' ? 'H1' : '',
    equitySharePct: null,
    inputs: {},
  };
}

/** A fresh form: the last six months, two empty members. */
export function newDraft(today: Date = new Date()): PortfolioDraft {
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const from = new Date(to.getTime() - 182 * 86_400_000);
  return {
    name: '',
    fromDate: isoDay(from),
    toDate: isoDay(to),
    initialBalance: null,
    accountCurrency: '',
    leverage: null,
    barMagnifier: 'script',
    limitsFrom: 'default',
    tradingAccountId: null,
    riskProfileId: null,
    legsOverride: null,
    correlatedOverride: null,
    members: [newMember(), newMember()],
  };
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Everything that keeps the form from queuing, in plain sentences (empty when it can run). */
export function validateDraft(d: PortfolioDraft): string[] {
  const problems: string[] = [];
  if (d.members.length === 0) problems.push('Add at least one member.');
  if (d.members.length > MAX_PORTFOLIO_MEMBERS)
    problems.push(`A portfolio has at most ${MAX_PORTFOLIO_MEMBERS} members.`);
  if (!d.fromDate || !d.toDate) problems.push('Choose the window: a start and an end date.');
  else if (d.toDate <= d.fromDate) problems.push('The window must end after it starts.');
  if (d.initialBalance !== null && !(d.initialBalance > 0)) problems.push('The starting balance must be above zero.');
  if (d.accountCurrency.trim() !== '' && !/^[A-Za-z]{3}$/.test(d.accountCurrency.trim()))
    problems.push('The account currency is a three-letter code, such as USD.');
  if (d.leverage !== null && !(d.leverage >= 1 && d.leverage <= 1_000))
    problems.push('Leverage must be between 1 and 1,000 (or empty for each script’s own margin).');
  if (d.limitsFrom === 'account' && d.tradingAccountId === null)
    problems.push('Choose the trading account whose risk profile sets the exposure limits.');
  if (d.limitsFrom === 'profile' && d.riskProfileId === null)
    problems.push('Choose the risk profile that sets the exposure limits.');
  for (const [label, v] of [
    ['currency-leg', d.legsOverride],
    ['correlated-positions', d.correlatedOverride],
  ] as const) {
    if (v !== null && !(Number.isInteger(v) && v >= 0))
      problems.push(`The ${label} limit is a whole number of positions, 0 for no limit.`);
  }
  d.members.forEach((m, i) => {
    const who = `Member ${i + 1}`;
    if (m.kind === 'strategy' && m.strategyId === null) problems.push(`${who}: choose a script strategy.`);
    if (m.kind === 'source') {
      if (m.pineSource.trim() === '') problems.push(`${who}: write the Pine source of a strategy() script.`);
      if (m.symbol.trim() === '' || m.timeframe.trim() === '')
        problems.push(`${who}: written source needs a symbol and a timeframe.`);
    }
    if (m.equitySharePct !== null && !(m.equitySharePct > 0 && m.equitySharePct <= 100))
      problems.push(`${who}: the equity share must be above 0 % and at most 100 %.`);
  });
  return problems;
}

/** The `POST portfolio-backtest` body of a valid form (empty fields left to the engine's defaults). */
export function buildRequest(d: PortfolioDraft): QueuePortfolioBacktestRequest {
  const request: QueuePortfolioBacktestRequest = {
    fromDate: `${d.fromDate}T00:00:00Z`,
    toDate: `${d.toDate}T00:00:00Z`,
    members: d.members.map((m) => {
      const member: QueuePortfolioBacktestRequest['members'][number] = {};
      if (m.kind === 'strategy' && m.strategyId !== null) member.strategyId = m.strategyId;
      if (m.kind === 'source') member.pineSource = m.pineSource;
      if (m.name.trim()) member.name = m.name.trim();
      if (m.symbol.trim()) member.symbol = m.symbol.trim().toUpperCase();
      if (m.timeframe.trim()) member.timeframe = m.timeframe.trim();
      if (m.equitySharePct !== null) member.equitySharePct = m.equitySharePct;
      if (Object.keys(m.inputs).length > 0) member.inputs = { ...m.inputs };
      return member;
    }),
  };
  if (d.name.trim()) request.name = d.name.trim();
  if (d.initialBalance !== null) request.initialBalance = d.initialBalance;
  if (d.accountCurrency.trim()) request.accountCurrency = d.accountCurrency.trim().toUpperCase();
  if (d.leverage !== null) request.leverage = d.leverage;
  if (d.barMagnifier !== 'script') request.barMagnifier = d.barMagnifier === 'on';
  if (d.limitsFrom === 'account' && d.tradingAccountId !== null) request.tradingAccountId = d.tradingAccountId;
  if (d.limitsFrom === 'profile' && d.riskProfileId !== null) request.riskProfileId = d.riskProfileId;
  if (d.legsOverride !== null) request.maxSameDirectionCurrencyLegs = d.legsOverride;
  if (d.correlatedOverride !== null) request.maxCorrelatedPositions = d.correlatedOverride;
  return request;
}

// ── runs ─────────────────────────────────────────────────────────────────────────────

/** Queued or running: the pages poll it. */
export function isActive(status: PortfolioRunStatus): boolean {
  return status === 'Queued' || status === 'Running';
}

/** The chip class of a status. */
export function statusChip(status: PortfolioRunStatus): string {
  switch (status) {
    case 'Completed':
      return 'chip-ok';
    case 'Failed':
      return 'chip-error';
    case 'Running':
      return 'chip-accent';
    case 'Cancelled':
      return 'chip-warn';
    default:
      return '';
  }
}

const REFUSAL_LABELS: Record<PortfolioRefusalKind, string> = {
  ExposureCap: 'Currency-exposure limit',
  Margin: 'Not enough free margin',
  NewsBlackout: 'News blackout',
  Other: 'Rejected by the emulator',
};

export function refusalKindLabel(kind: PortfolioRefusalKind): string {
  return REFUSAL_LABELS[kind] ?? kind;
}

/** How many entries the account did not take, per reason, most first. */
export function refusalCounts(refusals: readonly PortfolioRefusal[]): { kind: PortfolioRefusalKind; label: string; count: number }[] {
  const counts = new Map<PortfolioRefusalKind, number>();
  for (const r of refusals) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, label: refusalKindLabel(kind), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// ── member trades ────────────────────────────────────────────────────────────────────

const EXIT_REASON_LABELS: Record<string, string> = {
  StopLoss: 'Stop loss',
  TakeProfit: 'Take profit',
  EndOfData: 'End of the window',
  TrailingStop: 'Trailing stop',
  StrategyExit: 'The script’s exit',
  MarginCall: 'Margin call',
};

/** The engine's exit reason in words (an unknown one is shown as sent). */
export function exitReasonLabel(reason: string | null | undefined): string {
  if (!reason) return '—';
  return EXIT_REASON_LABELS[reason] ?? reason;
}

/** One row of a member's trade list: the engine's trade, its number in closing order and the P&L summed up to it. */
export interface MemberTradeRow {
  number: number;
  trade: PortfolioTrade;
  cumulativePnL: number;
}

/**
 * A member's trades the account held, in the order they closed (then opened), each with the member's P&L summed up to
 * and including it — how its contribution built up.
 */
export function memberTradeRows(trades: readonly PortfolioTrade[]): MemberTradeRow[] {
  const sorted = [...trades].sort(
    (a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime) || Date.parse(a.entryTime) - Date.parse(b.entryTime),
  );
  let sum = 0;
  return sorted.map((trade, i) => {
    sum += trade.pnL;
    return { number: i + 1, trade, cumulativePnL: sum };
  });
}

export interface MemberTradeSummary {
  trades: number;
  longs: number;
  shorts: number;
  winners: number;
  losers: number;
  netPnL: number;
  /** Mean R over the trades with an R (null when none has one). */
  averageR: number | null;
  rTrades: number;
}

/** Counts and sums over a member's trade list (every figure from the engine's trades). */
export function memberTradeSummary(trades: readonly PortfolioTrade[]): MemberTradeSummary {
  let longs = 0;
  let winners = 0;
  let losers = 0;
  let net = 0;
  let sumR = 0;
  let rTrades = 0;
  for (const t of trades) {
    if (t.direction === 'Buy') longs++;
    if (t.pnL > 0) winners++;
    else if (t.pnL < 0) losers++;
    net += t.pnL;
    if (t.rMultiple !== null && t.rMultiple !== undefined) {
      sumR += t.rMultiple;
      rTrades++;
    }
  }
  return {
    trades: trades.length,
    longs,
    shorts: trades.length - longs,
    winners,
    losers,
    netPnL: net,
    averageR: rTrades > 0 ? sumR / rTrades : null,
    rTrades,
  };
}

// ── correlation ──────────────────────────────────────────────────────────────────────

/**
 * A correlation cell's fill: the loss pole for members that move together (their losses come together), the gain pole
 * for members that offset each other, stronger with |r|. The value is printed in the cell, so colour is never the only cue.
 */
export function correlationFill(value: number | null, palette: ReportPalette): string {
  if (value === null || !Number.isFinite(value)) return 'transparent';
  const strength = Math.min(1, Math.abs(value));
  return withAlpha(value >= 0 ? palette.lossPole : palette.gainPole, 0.08 + strength * 0.45);
}

// ── charts ───────────────────────────────────────────────────────────────────────────

const ms = (iso: string) => Date.parse(iso);

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/**
 * The account over time: equity and balance, the fall from the running peak, and the margin its positions held — three
 * panels on one time axis (different units never share an axis). Null with fewer than two points.
 */
export function accountCurveOptions(result: PortfolioResult, palette: ReportPalette): EChartsOption | null {
  const curve = result.curve;
  if (curve.length < 2) return null;
  const currency = result.accountCurrency;
  const axisLabel = { color: palette.textMuted, fontSize: 11 };
  const splitLine = { lineStyle: { color: palette.gridLine } };
  return {
    animation: false,
    legend: { top: 0, textStyle: { color: palette.text, fontSize: 12 }, data: ['Equity', 'Balance'] },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? (params as { axisValue: number; seriesName: string; value: [number, number] }[]) : [];
        if (list.length === 0) return '';
        const lines = [esc(formatDateTime(list[0].axisValue))];
        for (const p of list) {
          const v = p.value[1];
          const text = p.seriesName === 'Drawdown' ? formatPercent(-v) : formatMoney(v, currency);
          lines.push(`${esc(p.seriesName)}: ${esc(text)}`);
        }
        return lines.join('<br/>');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 72, right: 24, top: 28, height: '46%' },
      { left: 72, right: 24, top: '62%', height: '15%' },
      { left: 72, right: 24, top: '82%', height: '12%' },
    ],
    xAxis: [0, 1, 2].map((i) => ({
      type: 'time' as const,
      gridIndex: i,
      axisLabel: { ...axisLabel, show: i === 2 },
      axisTick: { show: i === 2 },
      splitLine: { show: false },
    })),
    yAxis: [
      { type: 'value', gridIndex: 0, scale: true, name: currency, nameTextStyle: axisLabel, axisLabel, splitLine },
      { type: 'value', gridIndex: 1, name: 'DD %', nameTextStyle: axisLabel, axisLabel: { ...axisLabel, formatter: (v: number) => `−${v}` }, inverse: true, splitLine },
      { type: 'value', gridIndex: 2, name: 'Margin', nameTextStyle: axisLabel, axisLabel, splitLine },
    ],
    series: [
      {
        name: 'Equity',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        showSymbol: false,
        lineStyle: { color: palette.accent, width: 2 },
        itemStyle: { color: palette.accent },
        data: curve.map((p) => [ms(p.timeUtc), p.equity]),
      },
      {
        name: 'Balance',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        showSymbol: false,
        step: 'end',
        lineStyle: { color: palette.deEmphasis, width: 1 },
        itemStyle: { color: palette.deEmphasis },
        data: curve.map((p) => [ms(p.timeUtc), p.balance]),
      },
      {
        name: 'Drawdown',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        showSymbol: false,
        lineStyle: { color: palette.lossPole, width: 1 },
        itemStyle: { color: palette.lossPole },
        areaStyle: { color: withAlpha(palette.lossPole, 0.18) },
        data: curve.map((p) => [ms(p.timeUtc), p.drawdownPct]),
      },
      {
        name: 'Margin used',
        type: 'line',
        xAxisIndex: 2,
        yAxisIndex: 2,
        showSymbol: false,
        step: 'end',
        lineStyle: { color: palette.position, width: 1 },
        itemStyle: { color: palette.position },
        areaStyle: { color: withAlpha(palette.position, 0.15) },
        data: curve.map((p) => [ms(p.timeUtc), p.marginUsed]),
      },
    ],
  } as EChartsOption;
}

/**
 * The account's profit against the sum of its members' own backtests (each alone on its own capital): what sharing the
 * account changed. Null with fewer than two points.
 */
export function comparisonOptions(result: PortfolioResult, palette: ReportPalette): EChartsOption | null {
  const points = result.comparison.curve;
  if (points.length < 2) return null;
  const axisLabel = { color: palette.textMuted, fontSize: 11 };
  const portfolioName = `Portfolio (${result.accountCurrency})`;
  const standaloneName = `Members alone, summed (${result.comparison.currency})`;
  return {
    animation: false,
    legend: { top: 0, textStyle: { color: palette.text, fontSize: 12 } },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) => (typeof v === 'number' ? formatMoney(v, '', { signed: true }) : String(v)),
    },
    grid: { left: 72, right: 24, top: 32, bottom: 32 },
    xAxis: { type: 'time', axisLabel, splitLine: { show: false } },
    yAxis: { type: 'value', name: 'Profit', nameTextStyle: axisLabel, axisLabel, splitLine: { lineStyle: { color: palette.gridLine } } },
    series: [
      {
        name: portfolioName,
        type: 'line',
        showSymbol: false,
        lineStyle: { color: palette.accent, width: 2 },
        itemStyle: { color: palette.accent },
        data: points.map((p) => [ms(p.timeUtc), p.portfolioProfit]),
      },
      {
        name: standaloneName,
        type: 'line',
        showSymbol: false,
        lineStyle: { color: palette.deEmphasis, width: 1.5, type: 'dashed' },
        itemStyle: { color: palette.deEmphasis },
        data: points.map((p) => [ms(p.timeUtc), p.standaloneProfit]),
      },
    ],
  } as EChartsOption;
}

/** The currencies the account was most exposed to (largest |net| at any point), at most `max` of them. */
export function exposedCurrencies(points: readonly PortfolioExposurePoint[], max = 6): string[] {
  const peak = new Map<string, number>();
  for (const p of points)
    for (const c of p.currencies) peak.set(c.currency, Math.max(peak.get(c.currency) ?? 0, Math.abs(c.net)));
  return [...peak.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([c]) => c);
}

/** A categorical series colour from the palette's two poles and the de-emphasis grey, cycled with dashes. */
const SERIES_DASH = ['solid', 'dashed', 'dotted'] as const;

/**
 * Net exposure per currency over time as step lines: in open positions (+1 for each long, −1 for each short — what the
 * live currency-leg rule counts) or in account-currency value. Null without a currency the account was exposed to.
 */
export function exposureOptions(
  points: readonly PortfolioExposurePoint[],
  palette: ReportPalette,
  mode: 'legs' | 'notional',
  accountCurrency: string,
): EChartsOption | null {
  const currencies = exposedCurrencies(points);
  if (currencies.length === 0 || points.length === 0) return null;
  const axisLabel = { color: palette.textMuted, fontSize: 11 };
  const colours = [palette.accent, palette.lossPole, palette.deEmphasis, palette.position];
  return {
    animation: false,
    legend: { top: 0, textStyle: { color: palette.text, fontSize: 12 } },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) =>
        typeof v !== 'number' ? String(v) : mode === 'legs' ? formatNumber(v, 0, true) : formatMoney(v, accountCurrency, { signed: true }),
    },
    grid: { left: 72, right: 24, top: 32, bottom: 32 },
    xAxis: { type: 'time', axisLabel, splitLine: { show: false } },
    yAxis: {
      type: 'value',
      name: mode === 'legs' ? 'Net positions' : `Net value (${accountCurrency})`,
      nameTextStyle: axisLabel,
      minInterval: mode === 'legs' ? 1 : undefined,
      axisLabel,
      splitLine: { lineStyle: { color: palette.gridLine } },
    },
    series: currencies.map((currency, i) => ({
      name: currency,
      type: 'line',
      step: 'end',
      showSymbol: false,
      lineStyle: {
        color: colours[i % colours.length],
        width: 1.5,
        type: SERIES_DASH[Math.floor(i / colours.length) % SERIES_DASH.length],
      },
      itemStyle: { color: colours[i % colours.length] },
      data: points.map((p) => {
        const c = p.currencies.find((x) => x.currency === currency);
        return [ms(p.timeUtc), c ? (mode === 'legs' ? c.net : c.notional) : 0];
      }),
    })),
  } as EChartsOption;
}

/** The day's highest margin use as % of equity, one bar per trading day. Null without a day. */
export function marginOptions(days: readonly PortfolioMarginDay[], palette: ReportPalette): EChartsOption | null {
  if (days.length === 0) return null;
  const axisLabel = { color: palette.textMuted, fontSize: 11 };
  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) => (typeof v === 'number' ? formatPercent(v) : String(v)),
    },
    grid: { left: 56, right: 24, top: 24, bottom: 32 },
    xAxis: { type: 'time', axisLabel, splitLine: { show: false } },
    yAxis: { type: 'value', name: '% of equity', nameTextStyle: axisLabel, axisLabel, splitLine: { lineStyle: { color: palette.gridLine } } },
    series: [
      {
        name: 'Highest margin use',
        type: 'bar',
        barMaxWidth: 8,
        itemStyle: { color: withAlpha(palette.position, 0.8) },
        data: days.map((d) => [ms(`${d.day.slice(0, 10)}T00:00:00Z`), d.maxMarginUsePct]),
      },
    ],
  } as EChartsOption;
}

import { describe, expect, it } from 'vitest';

import {
  cloneRules,
  curveOption,
  dayStartUtc,
  defaultRules,
  lastId,
  limitTiles,
  mergeFeed,
  money,
  newPhase,
  optionalNumber,
  phaseSummary,
  ruleErrors,
  ruleLabel,
  stateClass,
} from './prop.logic';
import type { PropBreach, PropDashboard, PropRuleMetrics } from './prop.types';

const breach = (id: number): PropBreach => ({
  id,
  enrollmentId: 1,
  tradingAccountId: 1,
  accountLabel: 'A',
  traderId: 1,
  traderName: 'Ada',
  rule: 'MaxDailyLoss',
  severity: 'Breach',
  value: 1,
  limit: 1,
  occurredAtUtc: '2026-10-05T00:00:00Z',
  detail: 'x',
});

const metrics = (over: Partial<PropRuleMetrics> = {}): PropRuleMetrics => ({
  initialBalance: 10000,
  balance: 10200,
  equity: 10100,
  profitPct: 2,
  profitTargetPct: 10,
  profitTargetBalance: 11000,
  profitTargetMet: false,
  dailyLossReference: 10000,
  dailyLossLimit: 500,
  dailyLossFloor: 9500,
  dailyLossUsed: 400,
  dailyLossRemaining: 100,
  highWaterMark: 10300,
  drawdownLimit: 1000,
  drawdownFloor: 9000,
  drawdownRemaining: 1100,
  tradingDays: 3,
  minTradingDays: 4,
  totalProfit: 200,
  bestDayProfit: 150,
  bestDaySharePct: 75,
  consistencyMaxBestDayPct: 40,
  consistencyMet: false,
  timeLimitEndsAtUtc: null,
  currentDay: '2026-10-05',
  dayStartUtc: '2026-10-04T21:00:00Z',
  ...over,
});

describe('prop rules', () => {
  it('the default two-step program is valid and ends funded', () => {
    const r = defaultRules();
    expect(ruleErrors(r)).toEqual([]);
    expect(r.phases.map((p) => p.kind)).toEqual(['Evaluation', 'Verification', 'Funded']);
    expect(r.phases[2].profitTargetPct).toBeNull();
  });

  it('reports the problems the engine would refuse', () => {
    const r = defaultRules();
    r.tradingDay.resetTime = '25:00';
    r.phases[0].profitTargetPct = null;
    r.phases[0].maxDailyLossPct = 0;
    r.phases = [newPhase('Funded'), ...r.phases];
    r.profitSplit.traderSharePct = 120;
    const errors = ruleErrors(r);
    expect(errors.some((e) => e.includes('reset time'))).toBe(true);
    expect(errors.some((e) => e.includes('funded phase must be the last'))).toBe(true);
    expect(errors.some((e) => e.includes('profit target'))).toBe(true);
    expect(errors.some((e) => e.includes('daily loss'))).toBe(true);
    expect(errors.some((e) => e.includes('profit share'))).toBe(true);
  });

  it('clones deeply (editing the copy never changes the program)', () => {
    const r = defaultRules();
    const c = cloneRules(r);
    c.phases[0].weekend.startTime = '10:00';
    expect(r.phases[0].weekend.startTime).toBe('16:55');
  });

  it('summarises a phase in words', () => {
    const p = newPhase('Evaluation');
    p.drawdownMode = 'Trailing';
    p.trailingLocksAtInitialBalance = true;
    p.newsTradingAllowed = false;
    p.consistencyMaxBestDayPct = 30;
    const lines = phaseSummary(p);
    expect(lines).toContain('Profit target 10% (flat)');
    expect(lines.some((l) => l.startsWith('Trailing drawdown 10% (equity, locks at initial balance)'))).toBe(true);
    expect(lines).toContain('No trading ±2 min of high-impact news');
    expect(lines).toContain('Best day ≤ 30% of profit');
  });
});

describe('prop words and numbers', () => {
  it('labels and chips', () => {
    expect(ruleLabel('MaxOverallDrawdown')).toBe('Overall drawdown');
    expect(ruleLabel(null)).toBe('—');
    expect(stateClass('Failed')).toBe('bad');
    expect(stateClass('Funded')).toBe('ok');
    expect(money(1234.5, 'USD')).toBe('1,234.50 USD');
    expect(money(null)).toBe('—');
    expect(optionalNumber('')).toBeNull();
    expect(optionalNumber('12.5')).toBe(12.5);
    expect(Number.isNaN(optionalNumber('abc'))).toBe(true);
  });

  it('dates are UTC day starts', () => {
    expect(dayStartUtc('2026-10-01')).toBe('2026-10-01T00:00:00.000Z');
    expect(dayStartUtc('')).toBeNull();
    expect(dayStartUtc('01/10/2026')).toBeNull();
  });

  it('limit tiles say what is left and colour by how much is used', () => {
    const tiles = limitTiles(metrics());
    const daily = tiles.find((t) => t.label === 'Daily loss left')!;
    expect(daily.value).toBe('100.00');
    expect(daily.tone).toBe('bad'); // 80% used
    const dd = tiles.find((t) => t.label === 'Distance to drawdown limit')!;
    expect(dd.value).toBe('1,100.00');
    expect(dd.tone).toBe('ok');
    expect(tiles.find((t) => t.label.startsWith('Consistency'))!.tone).toBe('warn');
    expect(limitTiles(metrics({ dailyLossLimit: null, consistencyMaxBestDayPct: null })).map((t) => t.label)).toEqual([
      'Profit',
      'Distance to drawdown limit',
      'Trading days',
    ]);
  });
});

describe('breach feed', () => {
  it('puts new events on top without duplicates and remembers where it got to', () => {
    const merged = mergeFeed([breach(2), breach(1)], [breach(3), breach(2)]);
    expect(merged.map((b) => b.id)).toEqual([3, 2, 1]);
    expect(lastId(merged)).toBe(3);
    expect(lastId([])).toBeNull();
    expect(mergeFeed([], [breach(1), breach(2), breach(3)], 2).map((b) => b.id)).toEqual([3, 2]);
  });
});

describe('equity chart', () => {
  it('draws equity, balance and only the rule lines the phase has', () => {
    const d = {
      curve: [
        { atUtc: '2026-10-05T01:00:00Z', equity: 10000, balance: 10000, drawdownFloor: 9000, dailyLossFloor: 9500, profitTarget: 11000 },
        { atUtc: '2026-10-05T02:00:00Z', equity: 10100, balance: 10000, drawdownFloor: 9000, dailyLossFloor: 9500, profitTarget: 11000 },
      ],
    } as unknown as PropDashboard;
    const option = curveOption(d, false);
    const names = (option.series as { name: string }[]).map((s) => s.name);
    expect(names).toEqual(['Equity', 'Balance', 'Drawdown floor', 'Daily loss floor', 'Profit target']);

    const funded = {
      curve: d.curve.map((p) => ({ ...p, profitTarget: null, dailyLossFloor: null })),
    } as unknown as PropDashboard;
    expect((curveOption(funded, true).series as { name: string }[]).map((s) => s.name)).toEqual([
      'Equity',
      'Balance',
      'Drawdown floor',
    ]);
  });
});

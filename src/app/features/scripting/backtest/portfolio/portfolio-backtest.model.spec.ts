import { describe, expect, it } from 'vitest';

import { reportPalette } from '../../report/report-charts';
import {
  accountCurveOptions,
  buildRequest,
  correlationFill,
  exposedCurrencies,
  exposureOptions,
  isActive,
  marginOptions,
  newDraft,
  newMember,
  refusalCounts,
  validateDraft,
  type PortfolioDraft,
} from './portfolio-backtest.model';
import type { PortfolioExposurePoint, PortfolioRefusal, PortfolioResult } from './portfolio-backtest.types';

const palette = reportPalette('light');

function draft(over: Partial<PortfolioDraft> = {}): PortfolioDraft {
  const d = newDraft(new Date(Date.UTC(2026, 9, 9)));
  return {
    ...d,
    members: [
      { ...newMember('strategy'), strategyId: 7 },
      { ...newMember('source'), pineSource: 'strategy("x")', symbol: 'gbpusd', timeframe: 'H1' },
    ],
    ...over,
  };
}

describe('portfolio backtest form', () => {
  it('starts with the last six months and two members', () => {
    const d = newDraft(new Date(Date.UTC(2026, 9, 9)));
    expect(d.toDate).toBe('2026-10-09');
    expect(d.fromDate).toBe('2026-04-10');
    expect(d.members).toHaveLength(2);
  });

  it('accepts a complete form', () => {
    expect(validateDraft(draft())).toEqual([]);
  });

  it('names every problem in plain words', () => {
    const d = draft({
      fromDate: '2026-05-01',
      toDate: '2026-04-01',
      initialBalance: 0,
      accountCurrency: 'US',
      leverage: 5000,
      limitsFrom: 'account',
      legsOverride: 1.5,
      members: [
        newMember('strategy'),
        { ...newMember('source'), timeframe: '', equitySharePct: 120 },
      ],
    });
    expect(validateDraft(d)).toEqual([
      'The window must end after it starts.',
      'The starting balance must be above zero.',
      'The account currency is a three-letter code, such as USD.',
      'Leverage must be between 1 and 1,000 (or empty for each script’s own margin).',
      'Choose the trading account whose risk profile sets the exposure limits.',
      'The currency-leg limit is a whole number of positions, 0 for no limit.',
      'Member 1: choose a script strategy.',
      'Member 2: write the Pine source of a strategy() script.',
      'Member 2: written source needs a symbol and a timeframe.',
      'Member 2: the equity share must be above 0 % and at most 100 %.',
    ]);
  });

  it('sends only what the operator set, leaving the rest to the engine', () => {
    const d = draft();
    d.members[0].inputs = { Length: 21 };
    d.members[1].equitySharePct = 50;
    expect(buildRequest(d)).toEqual({
      fromDate: '2026-04-10T00:00:00Z',
      toDate: '2026-10-09T00:00:00Z',
      members: [
        { strategyId: 7, inputs: { Length: 21 } },
        { pineSource: 'strategy("x")', symbol: 'GBPUSD', timeframe: 'H1', equitySharePct: 50 },
      ],
    });
  });

  it('sends the account, the limits source and the overrides when set', () => {
    const request = buildRequest(
      draft({
        name: ' Majors ',
        initialBalance: 20_000,
        accountCurrency: 'eur',
        leverage: 30,
        barMagnifier: 'off',
        limitsFrom: 'profile',
        riskProfileId: 4,
        tradingAccountId: 17,
        legsOverride: 1,
        correlatedOverride: 0,
      }),
    );
    expect(request).toMatchObject({
      name: 'Majors',
      initialBalance: 20_000,
      accountCurrency: 'EUR',
      leverage: 30,
      barMagnifier: false,
      riskProfileId: 4,
      maxSameDirectionCurrencyLegs: 1,
      maxCorrelatedPositions: 0,
    });
    // The account is not the limits' source here, so its id is not sent.
    expect(request.tradingAccountId).toBeUndefined();
  });
});

describe('portfolio backtest runs', () => {
  it('polls only queued and running runs', () => {
    expect(isActive('Queued')).toBe(true);
    expect(isActive('Running')).toBe(true);
    expect(isActive('Completed')).toBe(false);
    expect(isActive('Failed')).toBe(false);
    expect(isActive('Cancelled')).toBe(false);
  });

  it('counts the refused entries per reason, most first', () => {
    const r = (kind: PortfolioRefusal['kind']): PortfolioRefusal => ({
      memberIndex: 0,
      member: 'A',
      symbol: 'EURUSD',
      kind,
      direction: 'Buy',
      lots: 1,
      price: 1.1,
      timeUtc: '2026-01-01T00:00:00Z',
      reason: 'x',
    });
    expect(refusalCounts([r('Margin'), r('ExposureCap'), r('ExposureCap')])).toEqual([
      { kind: 'ExposureCap', label: 'Currency-exposure limit', count: 2 },
      { kind: 'Margin', label: 'Not enough free margin', count: 1 },
    ]);
  });

  it('colours a correlation by sign and strength, and leaves a missing one clear', () => {
    expect(correlationFill(null, palette)).toBe('transparent');
    expect(correlationFill(0.9, palette)).not.toBe(correlationFill(-0.9, palette));
    expect(correlationFill(0.9, palette)).not.toBe(correlationFill(0.1, palette));
  });
});

describe('portfolio backtest charts', () => {
  const exposure: PortfolioExposurePoint[] = [
    {
      timeUtc: '2026-01-01T10:00:00Z',
      currencies: [
        { currency: 'USD', net: -2, long: 0, short: 2, notional: -20_000 },
        { currency: 'EUR', net: 1, long: 1, short: 0, notional: 10_000 },
        { currency: 'GBP', net: 1, long: 1, short: 0, notional: 10_000 },
      ],
    },
    { timeUtc: '2026-01-02T10:00:00Z', currencies: [] },
  ];

  it('orders the exposed currencies by their largest net exposure', () => {
    expect(exposedCurrencies(exposure)).toEqual(['USD', 'EUR', 'GBP']);
    expect(exposedCurrencies(exposure, 1)).toEqual(['USD']);
  });

  it('draws one step line per currency, in positions or in value', () => {
    const legs = exposureOptions(exposure, palette, 'legs', 'USD') as { series: { name: string; data: number[][] }[] };
    expect(legs.series.map((s) => s.name)).toEqual(['USD', 'EUR', 'GBP']);
    expect(legs.series[0].data).toEqual([
      [Date.parse('2026-01-01T10:00:00Z'), -2],
      [Date.parse('2026-01-02T10:00:00Z'), 0],
    ]);
    const value = exposureOptions(exposure, palette, 'notional', 'USD') as { series: { data: number[][] }[] };
    expect(value.series[0].data[0][1]).toBe(-20_000);
    expect(exposureOptions([], palette, 'legs', 'USD')).toBeNull();
  });

  it('draws the account curve only with two points or more', () => {
    const point = (t: string, equity: number) => ({ timeUtc: t, equity, balance: equity, drawdownPct: 0, marginUsed: 0 });
    const result = { accountCurrency: 'USD', curve: [point('2026-01-01T00:00:00Z', 10_000)] } as unknown as PortfolioResult;
    expect(accountCurveOptions(result, palette)).toBeNull();
    const two = { ...result, curve: [...result.curve, point('2026-01-02T00:00:00Z', 10_100)] } as PortfolioResult;
    const options = accountCurveOptions(two, palette) as { series: { name: string }[] };
    expect(options.series.map((s) => s.name)).toEqual(['Equity', 'Balance', 'Drawdown', 'Margin used']);
  });

  it('draws one margin bar per trading day', () => {
    expect(marginOptions([], palette)).toBeNull();
    const options = marginOptions(
      [{ day: '2026-01-02T00:00:00', equity: 10_000, maxMarginUsed: 500, minFreeMargin: 9_500, maxMarginUsePct: 5 }],
      palette,
    ) as { series: { data: number[][] }[] };
    expect(options.series[0].data).toEqual([[Date.parse('2026-01-02T00:00:00Z'), 5]]);
  });
});

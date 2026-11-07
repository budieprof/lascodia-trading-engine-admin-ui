import { describe, expect, it } from 'vitest';
import { studyDialogItems } from '../studies';
import { sumToBars } from './fx-fundamentals';
import {
  cotSeries,
  emptyNote,
  fundingInstants,
  fundingSeries,
  notApplicable,
  openInterestChange,
  paneApplies,
  premiumSeries,
  rollYieldSeries,
  type PaneScope,
} from './market-panes';
import type { DerivativesMinute } from './derivatives-data.service';

const fx: PaneScope = {
  symbol: 'EURUSD',
  kind: 'fx',
  perpetual: false,
  sourceId: null,
  futureRoot: null,
  currencies: ['EUR', 'USD'],
};
const aapl: PaneScope = {
  symbol: 'AAPL',
  kind: 'equity',
  perpetual: false,
  sourceId: null,
  futureRoot: null,
  currencies: [],
};
const perp: PaneScope = {
  symbol: 'BTC-USD-PERP',
  kind: 'crypto',
  perpetual: true,
  sourceId: 'crypto-kraken',
  futureRoot: null,
  currencies: [],
};
const es: PaneScope = {
  symbol: 'ESZ6',
  kind: 'future',
  perpetual: false,
  sourceId: null,
  futureRoot: 'ES',
  currencies: ['USD'],
};

const minute = (t: number, over: Partial<DerivativesMinute> = {}): DerivativesMinute => ({
  t,
  mark: null,
  index: null,
  funding: null,
  nextFundingT: null,
  oi: null,
  samples: 1,
  liqBuyQty: 0,
  liqBuyNotional: 0,
  liqSellQty: 0,
  liqSellNotional: 0,
  liqCount: 0,
  ...over,
});

const fundIds = (scope: PaneScope | null) =>
  studyDialogItems(scope)
    .filter((i) => i.kind === 'fundamental')
    .map((i) => i.id.replace('fund:', ''));

describe('fundamentals panes by symbol (UA03)', () => {
  it('FX keeps its four panes; the dialog without a scope still lists everything', () => {
    expect(fundIds(fx)).toEqual([
      'rate-differential',
      'swap-carry',
      'news-pressure',
      'economic-surprise',
      'cot',
      'basis',
    ]);
    expect(fundIds(null)).toHaveLength(11);
  });

  it('non-FX hides the FX panes and offers what can have data', () => {
    expect(fundIds(aapl)).toEqual([]);
    expect(fundIds(perp)).toEqual([
      'funding-rate',
      'open-interest',
      'basis',
      'liquidations',
      'funding-times',
    ]);
    expect(fundIds(es)).toEqual(['cot', 'term-structure']);
    expect(paneApplies('rate-differential', perp)).toBe(false);
    expect(notApplicable('swap-carry', aapl)).toBe('FX pairs only: AAPL is not a currency pair.');
  });

  it('funding in percent, premium from mark and index, OI change over its window', () => {
    const M = 60_000;
    const ms = [
      minute(0, { funding: 0.0001, oi: 100, mark: 101, index: 100 }),
      minute(30 * M, { funding: null, oi: 110 }),
      minute(60 * M, { funding: 0.0002, oi: 120, mark: 99, index: 100 }),
    ];
    expect(fundingSeries(ms).map((p) => p.value)).toEqual([0.01, 0.02]);
    expect(premiumSeries(ms).map((p) => Math.round(p.value * 100) / 100)).toEqual([1, -1]);
    expect(openInterestChange(ms, 60)).toEqual([{ time: 60 * M, value: 20 }]);
  });

  it('funding instants: each passed funding time at the rate charged before it', () => {
    const H = 3_600_000;
    const pts = fundingInstants([
      minute(0, { funding: 0.0001, nextFundingT: H }),
      minute(H - 60_000, { funding: 0.0002, nextFundingT: H }),
      minute(H + 60_000, { funding: 0.0003, nextFundingT: 2 * H }),
    ]);
    expect(pts).toEqual([{ time: H, value: 0.02 }]);
  });

  it('liquidations are summed per bar; empty minutes are real zeros, before the data null', () => {
    const pts = [
      { time: 60, value: 5 },
      { time: 70, value: 3 },
      { time: 130, value: 2 },
    ];
    expect(sumToBars(pts, [{ time: 0 }, { time: 50 }, { time: 100 }, { time: 150 }])).toEqual([
      null,
      8,
      2,
      0,
    ]);
  });

  it('roll yield from the front two live contracts; contango negative', () => {
    const D = 86_400_000;
    const day = Date.parse('2026-11-02T00:00:00Z');
    const last = new Map([
      ['ESZ6', day + 45 * D],
      ['ESH7', day + 136 * D],
    ]);
    const pts = rollYieldSeries(
      [
        {
          sourceId: 's',
          contract: 'ESZ6',
          root: 'ES',
          tradeDate: '2026-11-02',
          settlement: 6000,
          settlementFinal: true,
          openInterest: null,
          clearedVolume: null,
          close: null,
        },
        {
          sourceId: 's',
          contract: 'ESH7',
          root: 'ES',
          tradeDate: '2026-11-02',
          settlement: 6060,
          settlementFinal: true,
          openInterest: null,
          clearedVolume: null,
          close: null,
        },
      ],
      last,
    );
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBeCloseTo(((6000 - 6060) / 6060) * (365 / 91) * 100, 6);
    expect(rollYieldSeries([], last)).toEqual([]);
  });

  it('COT ascending by report date; empty notes carry the engine reason', () => {
    const rows = [
      { reportDate: '2026-11-03T00:00:00Z', netNonCommercialPositioning: 5 },
      { reportDate: '2026-10-27T00:00:00Z', netNonCommercialPositioning: 3 },
    ] as never[];
    expect(cotSeries(rows).map((p) => p.value)).toEqual([3, 5]);
    expect(
      emptyNote(
        'derivatives data',
        'btc-usd-perp',
        'No derivatives data for BTC-USD-PERP on crypto-okx in the window.',
      ),
    ).toBe(
      'No derivatives data for BTC-USD-PERP: No derivatives data for BTC-USD-PERP on crypto-okx in the window.',
    );
    expect(emptyNote('funding readings', 'x', 'Successful')).toBe('No funding readings for X.');
  });
});

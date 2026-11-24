import { describe, expect, it } from 'vitest';

import type { ScreenerRow } from '@features/scripting/api/scripting-api.types';

import {
  CLOSE_PLOT,
  levelQuality,
  mapRow,
  refreshDue,
  regimePhrase,
  sortRows,
  trendPhrase,
  vetoReasons,
  type DistanceFacts,
} from './playbook-board.model';

const FX: DistanceFacts = { unit: 0.0001, label: 'pips', digits: 5 };

function row(
  symbol: string,
  values: Record<string, number | null>,
  error: string | null = null,
): ScreenerRow {
  return { symbol, lastBarTimeMs: 1795532400000, values, alerts: [], error };
}

/** EURUSD H1 as the live screener answered on 2026-11-24 (trimmed). */
const EURUSD_HOLD = {
  'Best long': 1.09567,
  'Best short': 1.097251987000136,
  decision: 0,
  module: 0,
  'position module': 0,
  middle: 0,
  'best long class': 2,
  'best short class': 1,
  'best long visits': 5,
  'best long held': 3,
  'best short visits': 14,
  'best short held': 3,
  'veto mask': 161,
  'watch long state': 0,
  'watch short state': 0,
  regime: 1,
  'D1 bias': -1,
  'H4 bias': 0,
  [CLOSE_PLOT]: 1.09708,
};

describe('mapRow', () => {
  it('reads a HOLD at a level: classes, distances, trend, regime and the held-back reasons', () => {
    const r = mapRow(row('EURUSD', EURUSD_HOLD), FX);
    expect(r.callKind).toBe('hold');
    expect(r.call).toBe('HOLD');
    // 1.09567 is 14.1 pips below 1.09708; 1.09725 is 1.7 above → the sell level is nearer.
    expect(r.next).toBe('at sell level');
    expect(r.buy).toMatchObject({
      priceText: '1.09567',
      quality: 'reliable',
      heldText: 'held 3/5',
      weak: false,
    });
    expect(r.buy!.distanceText).toBe('14.1 pips below');
    expect(r.sell).toMatchObject({
      priceText: '1.09725',
      quality: 'weak',
      heldText: 'held 3/14',
      weak: true,
    });
    expect(r.sell!.distanceText).toBe('1.7 pips above');
    expect(r.trend).toBe('Daily down, 4h pausing');
    expect(r.regime).toBe('Trending: strong one-way moves');
    // 161 = 1 + 32 + 128
    expect(r.heldBack).toBe(
      'price is in the middle of its range; against the trend with no reversal sign and no trigger; the entry is too far from the level',
    );
    expect(r.heldResolved).toBeNull();
  });

  it('words TRADE NOW with entry, stop, target and R', () => {
    const r = mapRow(
      row('GBPNZD', {
        decision: 1,
        middle: 1,
        Entry: 2.38997,
        'plan stop': 2.386110714285714,
        'plan target': 2.395878142857143,
        'plan R': 1.530890246159592,
        'Best long': 2.38899,
        'Best short': 2.39894,
        [CLOSE_PLOT]: 2.39333,
      }),
      FX,
    );
    expect(r.callKind).toBe('trade');
    expect(r.call).toBe('TRADE NOW · BUY at 2.38997');
    expect(r.callDetail).toBe('exit 2.38611 if wrong · profit at 2.39588 · 1.5R');
    expect(r.next).toBe('trade now');
  });

  it('words WATCH SELL at the watched level and notes a resting order', () => {
    const r = mapRow(
      row('NZDJPY', {
        decision: -2,
        'Watch short': 87.365,
        'watch short state': 2,
        'Best long': 87.166,
        'Best short': 87.365,
        middle: 0,
        [CLOSE_PLOT]: 87.178,
      }),
      { unit: 0.01, label: 'pips', digits: 3 },
    );
    expect(r.callKind).toBe('watch');
    expect(r.call).toBe('WATCH · SELL at 87.365');
    expect(r.callDetail).toBe('order resting at the level');
    expect(r.next).toBe('wait for the sell level');
    expect(r.sell!.distanceText).toBe('18.7 pips above');
  });

  it('words WATCH BOTH SIDES', () => {
    const r = mapRow(
      row('AUDUSD', {
        decision: 3,
        'Watch long': 0.662,
        'Watch short': 0.665,
        middle: 1,
        [CLOSE_PLOT]: 0.6637,
      }),
      FX,
    );
    expect(r.call).toBe('WATCH · BOTH SIDES · buy at 0.66200, sell at 0.66500');
    expect(r.next).toBe('wait for either level');
  });

  it('words a virtual trade in progress', () => {
    const r = mapRow(row('USDJPY', { decision: 0, 'position module': -5, Entry: 159.2 }), {
      unit: 0.01,
      label: 'pips',
      digits: 3,
    });
    expect(r.callKind).toBe('in-trade');
    expect(r.call).toBe('IN A TRADE · SELL from 159.200');
    expect(r.next).toBe('in a trade');
  });

  it('shows prices without distances when the close or the pip is unknown', () => {
    const r = mapRow(row('XYZ', { decision: 0, 'Best long': 10.5 }), null);
    expect(r.buy).toMatchObject({ priceText: '10.5', distance: null, distanceText: '' });
    expect(r.sell).toBeNull();
    expect(r.next).toBe('at buy level');
  });

  it('keeps a screener error as a NO READING row', () => {
    const r = mapRow(row('AUDNZD', {}, 'No AUDNZD 60 bars between …'), FX);
    expect(r.callKind).toBe('error');
    expect(r.call).toBe('NO READING');
    expect(r.error).toContain('No AUDNZD');
  });

  it('reads held-back setups when the script reports them', () => {
    expect(
      mapRow(row('EURUSD', { ...EURUSD_HOLD, 'held n': 3, 'held R': 1.24 }), FX).heldResolved,
    ).toBe('3 resolved · +1.2R');
    expect(mapRow(row('EURUSD', { ...EURUSD_HOLD, 'held n': 0 }), FX).heldResolved).toBe(
      'none resolved',
    );
  });
});

describe('sortRows', () => {
  it('puts trade now, then watch, then hold, then errors — nearest level first within each', () => {
    const rows = [
      mapRow(row('ERR', {}, 'Not screened'), FX),
      mapRow(
        row('FAR', { decision: 0, 'Best long': 1.0, 'Best short': 1.2, [CLOSE_PLOT]: 1.1 }),
        FX,
      ),
      mapRow(
        row('NEAR', { decision: 0, 'Best long': 1.099, 'Best short': 1.2, [CLOSE_PLOT]: 1.1 }),
        FX,
      ),
      mapRow(row('WATCH', { decision: 2, 'Watch long': 1.0, [CLOSE_PLOT]: 1.1 }), FX),
      mapRow(row('TRADE', { decision: -1, Entry: 1.1, [CLOSE_PLOT]: 1.1 }), FX),
    ];
    expect(sortRows(rows).map((r) => r.symbol)).toEqual(['TRADE', 'WATCH', 'NEAR', 'FAR', 'ERR']);
  });
});

describe('phrases', () => {
  it('trend, regime, quality and veto bits follow the script', () => {
    expect(trendPhrase(1, 1)).toBe('Uptrend (daily & 4h)');
    expect(trendPhrase(-1, 1)).toBe('Daily down, 4h bouncing');
    expect(trendPhrase(0, -1)).toBe('No daily trend, 4h down');
    expect(trendPhrase(0, 0)).toBe('No trend (daily & 4h sideways)');
    expect(regimePhrase(5)).toBe('Breaking out');
    expect(regimePhrase(0)).toBe('Unclear');
    expect(levelQuality(3, 1, 2)).toBe('strong');
    expect(levelQuality(-1, null, null)).toBe('broken');
    expect(levelQuality(2, 5, 8)).toBe('reliable');
    expect(vetoReasons(32768)).toEqual(['reward too small for the risk']);
    expect(vetoReasons(0)).toEqual([]);
  });
});

describe('refreshDue', () => {
  const H = 3_600_000;
  const bar = Date.UTC(2026, 10, 24, 15); // the 15:00 H1 bar, closed at 16:00
  it('waits for the next bar to close, then re-reads', () => {
    expect(refreshDue(bar + 1.5 * H, bar + 1.05 * H, bar, H)).toBe(false);
    expect(refreshDue(bar + 2 * H + 60_000, bar + 1.05 * H, bar, H)).toBe(true);
  });
  it('re-reads at most every 15 minutes while no newer bar arrives', () => {
    expect(refreshDue(bar + 50 * H, bar + 50 * H - 10 * 60_000, bar, H)).toBe(false);
    expect(refreshDue(bar + 50 * H, bar + 50 * H - 16 * 60_000, bar, H)).toBe(true);
  });
  it('always reads the first time', () => {
    expect(refreshDue(bar, null, null, H)).toBe(true);
  });
});

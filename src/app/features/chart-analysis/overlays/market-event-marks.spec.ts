import { describe, expect, it } from 'vitest';
import { blackoutBands, eventCard, markKey, mergeMarks } from './chart-events';
import { corporateActionMarks, expiryMark, fundingMarks, marketMarkOf } from './market-event-marks';

const row = {
  id: 14,
  exposureKey: 'EQ:NVDA',
  kind: 'Earnings',
  scheduledAtUtc: '2026-11-17T21:05:00Z',
  impact: 'High',
  title: 'NVDA earnings (after the close)',
  source: 'nasdaq-earnings',
  firstSeenUtc: '2026-11-07T01:07:11Z',
  notes: 'exact time not published',
  actual: null,
};

describe('market event marks (UA01): only real rows', () => {
  it('a scheduled market event becomes an ERN mark with its source, never a modal event', () => {
    const m = marketMarkOf(row)!;
    expect(m.kind).toBe('market');
    expect(m.badge).toBe('ERN');
    expect(m.impact).toBe('High');
    expect(m.event).toBeUndefined();
    const card = eventCard(m, 'Tue 17 Nov 21:05 UTC', Date.parse('2026-11-07T00:00:00Z'));
    expect(card.rows.map((r) => r.label)).toEqual(['Due', 'Kind', 'For', 'Source', 'Note']);
    expect(card.surprise).toBeNull();
    expect(marketMarkOf({ ...row, scheduledAtUtc: 'nope' })).toBeNull();
  });

  it('funding marks: the distinct funding instants the feed reported, with the rate charged', () => {
    const t0 = Date.parse('2026-11-07T10:00:00Z');
    const H = 3_600_000;
    const marks = fundingMarks(
      'BTC-USD-PERP',
      [
        { t: t0 - 120_000, funding: 0.0001, nextFundingT: t0 },
        { t: t0 - 60_000, funding: 0.00012, nextFundingT: t0 },
        { t: t0 + 60_000, funding: 0.00005, nextFundingT: t0 + H },
      ],
      t0 + 2 * H,
    );
    expect(marks.map((m) => m.time)).toEqual([t0, t0 + H, t0 + 2 * H]);
    expect(marks[0].detail?.[0].value).toBe('0.0120% per interval');
    expect(marks[2].detail?.[0].value).toBe('not reported yet');
    expect(marks.every((m) => m.impact === 'Low' && m.kind === 'funding')).toBe(true);
  });

  it('expiry and corporate actions', () => {
    const e = expiryMark('esz6', Date.parse('2026-12-18T14:30:00Z'));
    expect(e.title).toBe('ESZ6 last trading day');
    expect(e.badge).toBe('EXP');
    expect(corporateActionMarks('AAPL', [])).toEqual([]);
    const [div] = corporateActionMarks('AAPL', [
      {
        kind: 'CashDividend',
        exDate: '2026-11-10',
        ratio: null,
        cashAmount: 0.26,
        currency: 'USD',
        source: 'x',
      },
    ]);
    expect(div.badge).toBe('DIV');
    expect(div.detail?.[0].value).toBe('0.26 USD');
  });

  it('ids of different kinds never collide when merged', () => {
    const econ = { id: 14, time: 1, title: 'CPI', currency: 'USD', impact: 'High' as const };
    const market = marketMarkOf(row)!;
    expect(markKey(econ)).not.toBe(markKey(market));
    expect(mergeMarks([econ], [market])).toHaveLength(2);
  });

  it('the blackout shades nothing when live enforces no currency (it shaded every High event before)', () => {
    const nfp = {
      id: 1,
      time: Date.parse('2026-10-09T12:30:00Z'),
      title: 'NFP',
      currency: 'USD',
      impact: 'High' as const,
    };
    const w = { active: true, minutesBefore: 30, minutesAfter: 25 };
    expect(blackoutBands([nfp], w, [])).toEqual([]);
    expect(blackoutBands([{ ...marketMarkOf(row)!, currency: 'USD' }], w, ['USD'])).toEqual([]);
    expect(blackoutBands([nfp], w, ['USD'])).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { continuousInfo, rollMarkers } from './futures-series';

describe('continuous futures (UD11)', () => {
  it('reads ES1! / ES1!U and pairs them', () => {
    expect(continuousInfo('ES1!')).toEqual({ root: 'ES', adjusted: true, counterpart: 'ES1!U' });
    expect(continuousInfo('es1!u')).toEqual({ root: 'ES', adjusted: false, counterpart: 'ES1!' });
    expect(continuousInfo('ESZ6')).toBeNull();
    expect(continuousInfo('EURUSD')).toBeNull();
  });

  it('puts a marker on the bar holding each roll of the root', () => {
    const H = 3_600_000;
    const t0 = Date.parse('2026-12-11T00:00:00Z');
    const bars = [0, 1, 2, 3].map((i) => ({ time: t0 + i * H }));
    const rolls = [
      {
        continuousSymbol: 'ES1!',
        root: 'ES',
        fromContract: 'ESZ6',
        toContract: 'ESH7',
        rollUtc: '2026-12-11T02:30:00Z',
        gap: 12.25,
        ratio: 1.002,
      },
      {
        continuousSymbol: 'NQ1!',
        root: 'NQ',
        fromContract: 'NQZ6',
        toContract: 'NQH7',
        rollUtc: '2026-12-11T02:30:00Z',
        gap: 40,
        ratio: 1,
      },
      {
        continuousSymbol: 'ES1!',
        root: 'ES',
        fromContract: 'ESU6',
        toContract: 'ESZ6',
        rollUtc: '2026-09-11T00:00:00Z',
        gap: 3,
        ratio: 1,
      },
    ];
    const m = rollMarkers(rolls, continuousInfo('ES1!')!, bars, 2);
    expect(m).toHaveLength(1);
    expect(m[0].time).toBe(t0 + 2 * H);
    expect(m[0].text).toBe('Roll ESZ6→ESH7 (adjusted by +12.25)');
    expect(rollMarkers(rolls, continuousInfo('ES1!U')!, bars, 2)[0].text).toBe(
      'Roll ESZ6→ESH7 (gap +12.25)',
    );
  });
});

import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';

import {
  classificationTone,
  csvFileName,
  curveChart,
  feedProblems,
  holdText,
  horizonLabel,
  isModuleNotInPlan,
  netLotsText,
  parseWriters,
  percent,
  pips,
  suggestionLabel,
  windowFor,
} from './dealing.logic';
import type { CurveSeries } from './dealing.types';

const series = (key: string, means: (number | null)[], ci = 0.1): CurveSeries => ({
  key,
  fills: 10,
  volumeLots: 5,
  markouts: [1_000, 5_000, 30_000, 60_000, 300_000].map((h, i) => ({
    horizonMs: h,
    n: 10,
    mean: means[i],
    volumeWeightedMean: null,
    stdDev: null,
    ci95: means[i] == null ? null : ci,
    tStat: null,
  })),
});

describe('dealing.logic', () => {
  it('labels horizons and formats pips, percents and holds', () => {
    expect([1_000, 5_000, 60_000, 300_000].map(horizonLabel)).toEqual([
      '1 s',
      '5 s',
      '1 min',
      '5 min',
    ]);
    expect(pips(1.234)).toBe('+1.23');
    expect(pips(-0.4)).toBe('−0.40');
    expect(pips(0)).toBe('0.00');
    expect(pips(null)).toBe('—');
    expect(percent(0.125, 1)).toBe('12.5%');
    expect(holdText(45)).toBe('45 s');
    expect(holdText(5_400)).toBe('1.5 h');
  });

  it('builds windows that end at the next minute', () => {
    const w = windowFor('24h', new Date('2026-10-24T10:00:30Z'));
    expect(w.toUtc).toBe('2026-10-24T10:01:00.000Z');
    expect(w.fromUtc).toBe('2026-10-23T10:01:00.000Z');
    expect(csvFileName(w)).toBe('ab-book-suggestions-20261023-20261024.csv');
  });

  it('recognises the plan refusing the broker module, and nothing else', () => {
    const refusal = new HttpErrorResponse({
      status: 403,
      error: {
        responseCode: '-403-quota',
        message: 'm',
        data: { quota: 'feature', feature: 'brokerModule', limit: 0, used: 0, plan: 'Trial' },
      },
    });
    expect(isModuleNotInPlan(refusal)).toBe(true);
    const sso = new HttpErrorResponse({
      status: 403,
      error: {
        responseCode: '-403-quota',
        message: 'm',
        data: { quota: 'feature', feature: 'sso', limit: 0, used: 0, plan: 'Trial' },
      },
    });
    expect(isModuleNotInPlan(sso)).toBe(false);
    expect(isModuleNotInPlan(new HttpErrorResponse({ status: 500 }))).toBe(false);
  });

  it('words suggestions as advice and tones classes', () => {
    expect(suggestionLabel('a-book-candidate')).toBe('A-book candidate');
    expect(suggestionLabel('none')).toBe('—');
    expect(classificationTone('toxic')).toBe('bad');
    expect(classificationTone('insufficient-data')).toBe('muted');
  });

  it('summarises net open lots largest first', () => {
    expect(netLotsText({ EURUSD: 80, GBPUSD: -3, USDJPY: 0 })).toBe('EURUSD +80, GBPUSD −3');
    expect(netLotsText({})).toBe('—');
  });

  it('draws the all-fills curve with its 95% band, then each series', () => {
    const o = curveChart(series('all', [0.1, 0.5, 1, 1.2, 1.5]), [
      series('EURUSD', [0.2, 0.6, null, 1.3, 1.4]),
    ]);
    const s = o.series as { name: string; data: (number | null)[] }[];
    expect(s.map((x) => x.name)).toEqual(['all (10)', 'all 95% CI', 'all 95% CI', 'EURUSD (10)']);
    expect(s[1].data[0]).toBeCloseTo(0.0); // lower = mean − ci
    expect(s[2].data[0]).toBeCloseTo(0.2); // band width = 2 × ci
    expect(s[3].data[2]).toBeNull();
  });

  it('validates the feed form', () => {
    expect(parseWriters('gw-1\ngw-1, gw-2 ;gw-3')).toEqual(['gw-1', 'gw-2', 'gw-3']);
    expect(
      feedProblems({ create: true, feedId: 'live-1', displayName: 'Live', writersText: 'gw-1' }),
    ).toEqual([]);
    expect(
      feedProblems({ create: true, feedId: 'own', displayName: 'x', writersText: '' }),
    ).toContain("'own' is reserved for the organisation's own accounts.");
    expect(
      feedProblems({ create: true, feedId: 'Bad Id', displayName: '', writersText: '' }),
    ).toHaveLength(2);
    expect(
      feedProblems({ create: false, feedId: 'Bad Id', displayName: 'ok', writersText: '' }),
    ).toEqual([]);
  });
});

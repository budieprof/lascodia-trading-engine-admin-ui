import { describe, expect, it } from 'vitest';

import {
  hasIntrabarEvidence,
  intrabarResolutionLabel,
  intrabarRows,
  magnifierCoverage,
} from './intrabar-evidence';

const NONE = {
  intrabarResolution: '',
  ambiguousBars: null,
  intrabarReorderedBars: null,
  walkedBars: null,
  magnifiedM1Bars: null,
  magnifiedLowerBars: null,
};

describe('C3 intrabar evidence in the report', () => {
  it('shows nothing for a report from an older engine', () => {
    expect(hasIntrabarEvidence(NONE)).toBe(false);
    expect(intrabarRows(NONE)).toEqual([]);
  });

  it('labels the resolution; absent on a C3 report = Pine path', () => {
    expect(intrabarResolutionLabel('Pessimistic')).toContain('adverse');
    expect(intrabarResolutionLabel('')).toContain('Pine');
    expect(intrabarResolutionLabel('Weird')).toBe('Weird');
  });

  it('computes magnifier coverage over walked bars', () => {
    const c = magnifierCoverage({
      ...NONE,
      walkedBars: 200,
      magnifiedM1Bars: 150,
      magnifiedLowerBars: 10,
    });
    expect(c).toEqual({ m1: 0.75, lower: 0.05, ohlc: 0.2 });
    expect(magnifierCoverage({ ...NONE, walkedBars: 0 })).toBeNull();
  });

  it('builds the run-property rows', () => {
    const rows = intrabarRows({
      ...NONE,
      intrabarResolution: 'Pessimistic',
      ambiguousBars: 12,
      walkedBars: 200,
      magnifiedM1Bars: 150,
      magnifiedLowerBars: 10,
    });
    expect(rows.map((r) => r.label)).toEqual([
      'Intrabar resolution',
      'Ambiguous bars',
      'Bars re-ordered by the resolution',
      'Fill path of 200 walked bars',
    ]);
    expect(rows[1].value).toBe('12');
    expect(rows[2].value).toBe('0');
    expect(rows[3].value).toBe('M1 75.0% · lower TF 5.0% · OHLC path 20.0%');
  });
});

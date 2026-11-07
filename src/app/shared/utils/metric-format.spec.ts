import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PF_NO_LOSS_SENTINEL,
  fmtFraction,
  fmtPct,
  fmtProfitFactor,
  fractionToPct,
  isNoLossProfitFactor,
} from './metric-format';

describe('metric-format', () => {
  it('prints a fraction as a percent', () => {
    expect(fmtFraction(0.523)).toBe('52.3%');
    expect(fmtFraction(0.5, 0)).toBe('50%');
    expect(fmtFraction(0)).toBe('0.0%');
    expect(fmtFraction(1)).toBe('100.0%');
  });

  it('prints a percent as is', () => {
    expect(fmtPct(12.345, 2)).toBe('12.35%');
    expect(fmtPct(-3.2)).toBe('-3.2%');
  });

  it('shows a dash for missing values', () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fmtFraction(v)).toBe('—');
      expect(fmtPct(v)).toBe('—');
      expect(fractionToPct(v)).toBeNull();
    }
  });

  it('converts fractions for charts', () => {
    expect(fractionToPct(0.25)).toBe(25);
  });

  it('reads 9999 as "no losing trades", never as a ratio', () => {
    expect(PF_NO_LOSS_SENTINEL).toBe(9999);
    expect(isNoLossProfitFactor(9999)).toBe(true);
    expect(isNoLossProfitFactor(1.4)).toBe(false);
    expect(fmtProfitFactor(9999)).toBe('∞');
    expect(fmtProfitFactor(1.456)).toBe('1.46');
    expect(fmtProfitFactor(0)).toBe('0.00');
    expect(fmtProfitFactor(9999, 2, false)).toBe('—');
    expect(fmtProfitFactor(null)).toBe('—');
  });
});

describe('no fraction printed as a percent', () => {
  const root = join(__dirname, '..', '..');
  // `winRate` on the wire is a FRACTION. `.toFixed()` on it is either printed with a "%" (wrong by
  // 100×) or as a bare 0.52 — both wrong. Use fmtFraction / fractionToPct. Names ending in Pct /
  // Percent (`winRatePct`) are already percents and are not matched.
  const BAD = /\bwinRate\s*(\(\))?\s*\??\.\s*toFixed\s*\(/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if ((p.endsWith('.ts') || p.endsWith('.html')) && !p.endsWith('.spec.ts')) out.push(p);
    }
    return out;
  }

  it('finds no winRate.toFixed(…) in the app', () => {
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = relative(root, file);
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (BAD.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { describeAlert, inputOf } from './chart-alert-rules';
import type { ChartAlertDto } from './chart-alerts.types';
import {
  availableMetrics,
  describeMetric,
  formatMetric,
  metricInput,
  metricProblem,
  type DerivativesSample,
} from './metric-alerts';
import { sampleOf, type CryptoDerivativesDto } from './metric-availability.service';

const perp: DerivativesSample = {
  sourceId: 'crypto-okx',
  label: 'OKX',
  funding: 0.0000741,
  mark: 75768.6,
  index: 75797.8,
  openInterest: 34332,
  minutes: 29,
  oiMinutes: 29,
};
const spot: DerivativesSample = {
  sourceId: 'crypto-coinbase',
  label: 'Coinbase',
  funding: null,
  mark: null,
  index: null,
  openInterest: null,
  minutes: 0,
  oiMinutes: 0,
};

describe('metric alerts (UF04)', () => {
  it('a perpetual with data offers every kind; a spot market none', () => {
    const a = availableMetrics([perp]);
    expect(a.map((x) => x.kind)).toEqual(['Funding', 'OpenInterestChange', 'Basis', 'Liquidations']);
    expect(a[0].current).toBeCloseTo(0.00741, 8);
    expect(a[2].current).toBeCloseTo(((75768.6 - 75797.8) / 75797.8) * 100, 6);
    expect(availableMetrics([spot])).toEqual([]);
    expect(availableMetrics([])).toEqual([]);
  });

  it('live funding without stored rows: no OI change and no liquidations', () => {
    const a = availableMetrics([{ ...perp, minutes: 0, oiMinutes: 0 }]);
    expect(a.map((x) => x.kind)).toEqual(['Funding', 'Basis']);
  });

  it('FX with a fresh CME basis offers basis only', () => {
    const a = availableMetrics([], { sourceId: 'cme-6e', label: 'CME', percent: null });
    expect(a.map((x) => x.kind)).toEqual(['Basis']);
    expect(a[0].sources[0].sourceId).toBe('cme-6e');
  });

  it("refuses what the engine's validator refuses", () => {
    const d = { kind: 'Liquidations' as const, comparator: 'above' as const, value: 1e6, windowMinutes: 60, sourceId: null };
    expect(metricProblem(d, 'once')).toBeNull();
    expect(metricProblem({ ...d, value: null }, 'once')).toBe('Enter the liquidations value.');
    expect(metricProblem({ ...d, value: -1 }, 'once')).toContain('cannot be negative');
    expect(metricProblem({ ...d, windowMinutes: 0 }, 'once')).toContain('between 1 and 1440');
    expect(metricProblem({ ...d, windowMinutes: 1441 }, 'once')).toContain('between 1 and 1440');
    expect(metricProblem(d, 'once_per_bar_close')).toContain('not at bar closes');
    expect(metricProblem({ ...d, kind: 'Funding', value: -0.01, windowMinutes: null }, 'all')).toBeNull();
    expect(metricInput({ ...d, kind: 'Funding' }).windowMinutes).toBeNull();
    expect(metricInput({ ...d, sourceId: '' }).sourceId).toBeNull();
  });

  it('formats and describes in the kind’s unit', () => {
    expect(formatMetric('Funding', 0.01)).toBe('0.0100 % per interval');
    expect(formatMetric('OpenInterestChange', 2.345)).toBe('+2.35 %');
    expect(formatMetric('Basis', -0.042)).toBe('-0.0420 %');
    expect(formatMetric('Liquidations', 1250000)).toBe('1,250,000 notional');
    expect(
      describeMetric('Liquidations', { comparator: 'crossesAbove', value: 1e6, windowMinutes: 60, sourceId: 'crypto-okx' }),
    ).toBe('Liquidations crosses above 1,000,000 notional over 60 min (crypto-okx)');
    const alert = {
      kind: 'Funding',
      frequency: 'once',
      side: 'Mid',
      condition: 'CrossingUp',
      price: null,
      channels: ['InApp'],
      metric: { comparator: 'above', value: 0.01, windowMinutes: null, sourceId: null, unit: 'percentPerInterval' },
    } as unknown as ChartAlertDto;
    expect(describeAlert(alert, 2)).toBe('Funding rate is above 0.0100 % per interval · only once');
    expect(inputOf(alert).metric).toEqual({ comparator: 'above', value: 0.01, windowMinutes: null, sourceId: null });
  });

  it('samples a derivatives answer: live values when fresh, else the newest stored minute', () => {
    const dto: CryptoDerivativesDto = {
      sourceId: 'crypto-okx',
      symbol: 'BTC-USDT-PERP',
      latest: { mark: 2, index: 1, funding: 0.0001, openInterest: 10 },
      latestAgeMs: 1000,
      minutes: [
        { t: 1, mark: 5, index: 4, funding: 0.0002, oi: 9 },
        { t: 2, mark: null, index: null, funding: null, oi: null },
      ],
    };
    expect(sampleOf(dto, 'OKX')).toMatchObject({ funding: 0.0001, mark: 2, index: 1, openInterest: 10, minutes: 2, oiMinutes: 1 });
    const stale = sampleOf({ ...dto, latestAgeMs: 20 * 60_000 }, 'OKX');
    expect(stale).toMatchObject({ funding: 0.0002, mark: 5, index: 4, openInterest: 9 });
    expect(sampleOf({ ...dto, latest: null, minutes: [] }, 'OKX')).toMatchObject({ funding: null, minutes: 0 });
  });
});

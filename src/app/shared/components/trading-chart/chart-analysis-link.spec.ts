import { describe, it, expect } from 'vitest';
import {
  TIMEFRAME_PILLS,
  TF_TO_RESOLUTION,
  FALLBACK_RESOLUTION,
  chartAnalysisTarget,
} from './chart-analysis-link';
import { SUPPORTED_RESOLUTIONS } from '@features/chart-analysis/datafeed/resolution';

describe('chart-analysis deep link', () => {
  /**
   * The invariant this whole module exists for. The embedded chart's pills and
   * the chart-analysis datafeed are in different features and neither imports
   * the other at runtime, so nothing but this test notices when they drift.
   */
  it('maps every timeframe pill to a resolution the datafeed serves', () => {
    for (const pill of TIMEFRAME_PILLS) {
      const resolution = TF_TO_RESOLUTION[pill.value];
      expect(resolution, `pill "${pill.value}" has no resolution mapping`).toBeDefined();
      expect(
        SUPPORTED_RESOLUTIONS,
        `pill "${pill.value}" maps to "${resolution}", which the datafeed cannot serve`,
      ).toContain(resolution);
    }
  });

  it('maps no resolution the datafeed cannot serve', () => {
    for (const resolution of Object.values(TF_TO_RESOLUTION)) {
      expect(SUPPORTED_RESOLUTIONS).toContain(resolution);
    }
  });

  it('keeps the fallback servable too', () => {
    // The fallback is only reached by a mis-wired pill, but an unservable
    // fallback turns that near-miss into a blank chart.
    expect(SUPPORTED_RESOLUTIONS).toContain(FALLBACK_RESOLUTION);
  });

  it('converts the slash display form to the engine form', () => {
    const { commands } = chartAnalysisTarget('EUR/USD', 'H1');
    expect(commands).toEqual(['/chart-analysis', 'EURUSD']);
  });

  it('strips every slash, not just the first', () => {
    const { commands } = chartAnalysisTarget('A/B/C', 'H1');
    expect(commands[1]).toBe('ABC');
  });

  it('passes a symbol that is already in engine form through unchanged', () => {
    expect(chartAnalysisTarget('EURUSD', 'M5').commands[1]).toBe('EURUSD');
  });

  it('carries the selected timeframe across as a TradingView resolution', () => {
    expect(chartAnalysisTarget('EUR/USD', 'M15').queryParams).toEqual({ tf: '15' });
    expect(chartAnalysisTarget('EUR/USD', 'D1').queryParams).toEqual({ tf: '1D' });
  });

  it('falls back rather than emitting an unknown resolution', () => {
    expect(chartAnalysisTarget('EUR/USD', 'W1').queryParams).toEqual({
      tf: FALLBACK_RESOLUTION,
    });
  });
});

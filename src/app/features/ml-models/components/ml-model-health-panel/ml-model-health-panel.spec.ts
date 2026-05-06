import { describe, it, expect } from 'vitest';
import { estimateMccFromAccuracyAndF1 } from './ml-model-health-panel.component';

describe('estimateMccFromAccuracyAndF1', () => {
  it('returns null when either input is missing', () => {
    expect(estimateMccFromAccuracyAndF1(null, 0.5)).toBeNull();
    expect(estimateMccFromAccuracyAndF1(0.5, null)).toBeNull();
    expect(estimateMccFromAccuracyAndF1(undefined, 0.5)).toBeNull();
  });

  it('returns null when inputs are out of range', () => {
    expect(estimateMccFromAccuracyAndF1(-0.1, 0.5)).toBeNull();
    expect(estimateMccFromAccuracyAndF1(1.1, 0.5)).toBeNull();
    expect(estimateMccFromAccuracyAndF1(0.5, 1.5)).toBeNull();
  });

  it('flags the predict-majority collapser as zero skill regardless of accuracy', () => {
    // The exact USDCAD H1 FtTransformer signature: 73.7% accuracy, F1 = 0.0.
    // Without this property the metric would let dead models look successful.
    expect(estimateMccFromAccuracyAndF1(0.737, 0.0)).toBe(0);
    expect(estimateMccFromAccuracyAndF1(0.95, 0.0)).toBe(0);
  });

  it('returns 1 for a perfect classifier', () => {
    expect(estimateMccFromAccuracyAndF1(1.0, 1.0)).toBe(1);
  });

  it('produces a positive MCC for a balanced moderately-skilled model', () => {
    // accuracy 0.60 + F1 0.55 → MCC roughly in the 0.18–0.22 range.
    const mcc = estimateMccFromAccuracyAndF1(0.6, 0.55)!;
    expect(mcc).not.toBeNull();
    expect(mcc).toBeGreaterThan(0.15);
    expect(mcc).toBeLessThan(0.25);
  });

  it('keeps near-degenerate cases small under the symmetric assumption', () => {
    // High accuracy + tiny F1 is a realisable matrix mathematically, but
    // operationally this is the predict-majority pattern. The symmetric
    // assumption gives an optimistic but small positive MCC; the warnings
    // panel and F1 column flag it independently.
    const mcc = estimateMccFromAccuracyAndF1(0.95, 0.1)!;
    expect(mcc).not.toBeNull();
    expect(mcc).toBeLessThan(0.1);
  });
});

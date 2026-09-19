import { describe, expect, it } from 'vitest';
import { volumeProfileSpan } from './advanced-painters';

/**
 * Regression guard for a bug that shipped and survived a browser check.
 *
 * The anchored profile asked `coordinateToTime(paneWidth)` for its upper
 * bound. Lightweight Charts returns null for any coordinate past the last bar,
 * and the pane always keeps a right-hand margin, so that call reliably returned
 * null and the painter bailed before drawing. The tool created its object and
 * drew its anchor line, so BOTH the object count and a canvas pixel-diff said
 * it had worked — it just never drew a histogram.
 */
describe('volumeProfileSpan', () => {
  // The real failure: the right edge has no time because it is past the data.
  const timeAt = (x: number): number | null => (x > 1000 ? null : 1_700_000_000_000 + x * 60_000);

  it('anchored: survives a right edge that has no time', () => {
    const span = volumeProfileSpan('anchored', 200, undefined, timeAt);
    expect(span, 'anchored profile produced no span — it would draw nothing').not.toBeNull();
    expect(span!.t0).toBe(timeAt(200));
    // Unbounded: the profile runs to the newest bar, whatever that is.
    expect(span!.t1).toBe(Infinity);
  });

  it('anchored: still fails closed when the ANCHOR itself is off-data', () => {
    expect(volumeProfileSpan('anchored', 1200, undefined, timeAt)).toBeNull();
  });

  it('fixed: spans the two clicks, in either drag direction', () => {
    const a = volumeProfileSpan('fixed', 200, 600, timeAt);
    const b = volumeProfileSpan('fixed', 600, 200, timeAt);
    expect(a).toEqual(b);
    expect(a!.t0).toBe(timeAt(200));
    expect(a!.t1).toBe(timeAt(600));
  });

  it('fixed: fails closed when either click is off-data', () => {
    expect(volumeProfileSpan('fixed', 200, 1200, timeAt)).toBeNull();
    expect(volumeProfileSpan('fixed', 1200, 200, timeAt)).toBeNull();
  });

  it('fixed: a single click collapses to a zero-width span, not a crash', () => {
    const span = volumeProfileSpan('fixed', 300, undefined, timeAt);
    expect(span!.t0).toBe(span!.t1);
  });
});

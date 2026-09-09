/**
 * Structural equality for signals that are re-assigned from a network response.
 *
 * A refetch always produces a brand-new array, so a signal on default
 * (reference) equality reports a change even when the payload is byte-identical
 * — every downstream `computed` re-runs and the DOM under it is rebuilt. On a
 * table of open positions that is a visible full-table repaint on every sweep,
 * which is what a "live" page must not do.
 *
 * Pass this as `signal(initial, { equal: structuralEqual })` for any signal fed
 * by a fetch. Identical data then ends the update at the signal.
 *
 * Size guard: serialising a very large payload on every refresh would cost more
 * than the repaint it saves, so past the cap we report "different" and let the
 * normal render path run.
 */
const MAX_STRUCTURAL_COMPARE_BYTES = 512 * 1024;

export function structuralEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  try {
    const sa = JSON.stringify(a);
    if (sa.length > MAX_STRUCTURAL_COMPARE_BYTES) return false;
    return sa === JSON.stringify(b);
  } catch {
    // Cyclic or non-serialisable — treat as changed.
    return false;
  }
}

import type { SpreadBumpStatus } from '@core/api/api.types';

/** The fields of a position row the spread-bump pill reads. */
export interface SpreadBumpFields {
  stopLoss: number | null;
  originalStopLoss: number | null;
  bumpedAt: string | null;
  bumpedSpread: number | null;
  bumpedSlSnapshot: number | null;
  bumpReason: string | null;
  /** The engine's reading of the bump group (engine D120); absent on older engines. */
  spreadBumpStatus?: SpreadBumpStatus | null;
  /** The signed offset of a bump in force (engine D120); absent on older engines. */
  spreadBumpOffset?: number | null;
}

/** What the stop-loss cell shows for a row's spread-bump state. */
export interface SpreadBumpDisplay {
  label: string;
  /** `active` — the broker stop really is widened; `muted` — a group is on file but the stop is not widened. */
  tone: 'active' | 'muted';
  title: string;
}

/**
 * The spread-bump state of a row, as the engine reads it (engine `SpreadBumpState`). An older engine does not send
 * `spreadBumpStatus`, so it is derived from the raw bump fields the same way.
 */
export function spreadBumpStatusOf(p: SpreadBumpFields): SpreadBumpStatus {
  if (p.spreadBumpStatus) return p.spreadBumpStatus;
  if (p.bumpedAt === null || p.originalStopLoss === null || p.bumpedSlSnapshot === null)
    return 'None';
  if (p.stopLoss !== p.bumpedSlSnapshot) return 'Drifted';
  return p.bumpedSlSnapshot === p.originalStopLoss ? 'ArmedNoOffset' : 'InForce';
}

/**
 * The pill for a row's spread-bump state (engine D120), or null when there is none.
 *
 * - `InForce` — the broker stop carries a bump: "bumped", with the offset and the stop it reverts to.
 * - `ArmedNoOffset` — a stop move carried the bump down to nothing (a stop on the entry leaves no distance to widen), so
 *   the stop is NOT widened; the group only waits for the spread to calm. It used to read "bumped" (original == current).
 * - `Drifted` — something else moved the stop off the bumped level; the revert will leave it where it is.
 */
export function spreadBumpDisplay(p: SpreadBumpFields): SpreadBumpDisplay | null {
  const status = spreadBumpStatusOf(p);
  const reason = p.bumpReason ?? 'SPREAD';
  const since = p.bumpedAt ? ` · since ${new Date(p.bumpedAt).toISOString()}` : '';
  const spread = p.bumpedSpread !== null ? ` · spread at bump ${p.bumpedSpread}` : '';

  switch (status) {
    case 'InForce': {
      const offset =
        p.spreadBumpOffset ??
        (p.bumpedSlSnapshot !== null && p.originalStopLoss !== null
          ? p.bumpedSlSnapshot - p.originalStopLoss
          : null);
      const by = offset !== null ? ` by ${Number(offset.toFixed(8))}` : '';
      const origin =
        p.originalStopLoss !== null
          ? `reverts to ${p.originalStopLoss}`
          : 'no original SL recorded';
      return {
        label: 'bumped',
        tone: 'active',
        title: `${reason} bump${by} — ${origin}${spread}${since}`,
      };
    }
    case 'ArmedNoOffset':
      return {
        label: 'bump armed',
        tone: 'muted',
        title:
          `${reason} bump armed with no offset — a stop move carried none of it (a stop on the entry leaves no distance ` +
          `to widen), so this stop is not widened. Clears when the spread calms; a fresh spike widens the stop once it ` +
          `leaves the entry${since}`,
      };
    case 'Drifted':
      return {
        label: 'bump drifted',
        tone: 'muted',
        title:
          `${reason} bump no longer in force — the stop was moved off the bumped level ` +
          `(${p.bumpedSlSnapshot ?? '—'}); the revert will leave it where it is${since}`,
      };
    default:
      return null;
  }
}

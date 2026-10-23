import type { DayOf, Ohlc } from '../indicators/math';
import { barIntervalOf, type DevelopingProfile } from '../profiles/profile-math';
import {
  periodBins,
  periodProfiles,
  profileWithValueArea,
  sessionProfileNotice,
  type PeriodProfile,
  type VolumeProfileMode,
} from './analysis-overlays';

/**
 * Levels derived from the chart-level period profiles (PR-2, PR-3): naked POCs and the developing
 * POC / value area. Pure, so where a line starts and stops is testable without a chart.
 *
 * <p>Both work on the profiles the overlay draws ({@link PeriodProfile}, from `periodProfiles`), so a
 * naked POC is exactly the POC drawn in its session, and a developing line ends exactly on it.</p>
 */

/** A period's POC carried to the right until price trades through it (PR-2). */
export interface OverlayNakedPoc {
  price: number;
  /** The period's last bar (UTC ms): where the line starts. */
  from: number;
  /** The first LATER bar whose range holds the price (UTC ms), or null: still naked. */
  until: number | null;
  /** "nPOC London 20 Oct", "nPOC Mon 20 Oct". */
  label: string;
  /** The period it came from, for the hover's provenance. */
  period: string;
  /** Bars in that period. */
  bars: number;
}

/** How many naked POCs the chart carries by default — the most recent ones; older ones are clutter. */
export const NAKED_POC_LIMIT = 10;

/**
 * The POCs of the most recent `limit` FINISHED periods, each from its period's last bar until the first
 * later bar whose high–low range holds it ("touched"), or still naked.
 *
 * <p>"Finished" means some bar came after it: the period holding the newest bar is still forming, its
 * POC is still moving, and calling it naked would be meaningless. A touch is judged on bars strictly
 * after the period — a POC is always inside its own period's range.</p>
 */
export function nakedPocLevels(
  bars: readonly Ohlc[],
  periods: readonly PeriodProfile[],
  limit = NAKED_POC_LIMIT,
): OverlayNakedPoc[] {
  const last = bars.length - 1;
  const finished = periods
    .filter((p) => p.endIdx < last && p.endIdx >= p.startIdx)
    .sort((a, b) => a.t1 - b.t1);
  const recent = finished.slice(Math.max(0, finished.length - Math.max(0, limit)));
  return recent.map((p) => {
    const price = p.profile.poc;
    let until: number | null = null;
    for (let i = p.endIdx + 1; i <= last; i++) {
      if (bars[i].low <= price && bars[i].high >= price) {
        until = bars[i].time;
        break;
      }
    }
    return {
      price,
      from: p.t1,
      until,
      label: `nPOC ${p.label}`,
      period: p.label,
      bars: p.endIdx - p.startIdx + 1,
    };
  });
}

/** One period's developing POC / VAH / VAL, with the period it belongs to. */
export interface OverlayDeveloping extends DevelopingProfile {
  period: string;
}

/**
 * Where the POC, VAH and VAL stood bar by bar as each period developed (PR-3, Sierra's "developing"
 * lines): at bar k, the profile of the period's bars up to and including k — on its own range, so no
 * point knows a later bar's price. The row count is the full period's ({@link periodBins}), so the last
 * point is exactly the profile the overlay draws for the period.
 *
 * <p>`t[k]` is bar k's open; the level holds from there until the next bar's open.</p>
 */
export function developingLevels(
  bars: readonly Ohlc[],
  periods: readonly PeriodProfile[],
): OverlayDeveloping[] {
  const out: OverlayDeveloping[] = [];
  for (const p of periods) {
    const rows = periodBins(p.endIdx - p.startIdx + 1);
    const d: OverlayDeveloping = { period: p.label, t: [], poc: [], vah: [], val: [] };
    for (let k = p.startIdx; k <= p.endIdx; k++) {
      const vp = profileWithValueArea(bars.slice(p.startIdx, k + 1), rows);
      if (!vp) continue;
      d.t.push(bars[k].time);
      d.poc.push(vp.poc);
      d.vah.push(vp.valueAreaHigh);
      d.val.push(vp.valueAreaLow);
    }
    if (d.t.length) out.push(d);
  }
  return out;
}

/** The volume-profile options beyond its mode (the chips under "Volume profile"; saved with the layout). */
export interface ProfileExtrasSettings {
  /** Naked POCs of the trading days — or of the Asia / London / New York sessions in that mode. */
  nakedPocs: boolean;
  /** Developing POC / VAH / VAL through each period (not in Visible Range: it is one profile). */
  developing: boolean;
}

export const DEFAULT_PROFILE_EXTRAS: ProfileExtrasSettings = { nakedPocs: false, developing: false };

/** What the overlay draws besides the profiles themselves. */
export interface ProfileExtras {
  naked: OverlayNakedPoc[];
  developing: OverlayDeveloping[];
  /** Why the chosen mode draws nothing on these bars, or null. */
  notice: string | null;
}

/**
 * The naked POCs, developing lines and notice for the chart-level profile in `mode`, given the
 * `periods` it draws. Naked POCs come from the sessions in `sessions` mode and from the trading days
 * in every other mode; developing lines follow the drawn periods.
 */
export function profileExtras(
  bars: readonly Ohlc[],
  periods: readonly PeriodProfile[],
  mode: VolumeProfileMode,
  settings: ProfileExtrasSettings,
  dayOf?: DayOf,
): ProfileExtras {
  const notice = mode === 'sessions' ? sessionProfileNotice(barIntervalOf(bars)) : null;
  let naked: OverlayNakedPoc[] = [];
  if (settings.nakedPocs && !notice) {
    const source =
      mode === 'sessions' || mode === 'session' ? periods : periodProfiles(bars, 'session', { dayOf });
    naked = nakedPocLevels(bars, source);
  }
  const developing =
    settings.developing && mode !== 'visible' && !notice ? developingLevels(bars, periods) : [];
  return { naked, developing, notice };
}

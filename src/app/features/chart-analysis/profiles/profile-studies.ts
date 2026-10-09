import type { TradingDays } from '../datafeed/session-calendar';
import type { Ohlc } from '../indicators/math';
import type { IndicatorInput } from '../indicators/registry';
import {
  autoAnchoredProfile,
  barIntervalOf,
  compositeProfile,
  developingProfile,
  fixedRangeProfile,
  nakedPocs,
  periodicProfiles,
  sessionProfiles,
  tpoProfile,
  visibleRangeProfile,
  type AutoAnchor,
  type DevelopingProfile,
  type NakedPoc,
  type ProfileOptions,
  type ProfilePeriod,
  type SessionName,
  type SessionProfile,
  type TpoProfile,
  type VolumeProfile,
} from './profile-math';

/**
 * IndicatorInput plus a select type for enum parameters (session, period, anchor) and `time` — an instant picked on
 * the chart (UTC ms; 0 = not set), shown as a date, never typed as milliseconds (DR-22).
 */
export type ProfileInput =
  | IndicatorInput
  | { key: string; label: string; type: 'select'; default: string; options: readonly string[] }
  | { key: string; label: string; type: 'time'; default: number };

export type ProfileStudyId =
  | 'vp-visible'
  | 'vp-session'
  | 'vp-periodic'
  | 'vp-fixed'
  | 'vp-auto-anchored'
  | 'vp-composite'
  | 'tpo';

export interface ProfileStudyDef {
  id: ProfileStudyId;
  name: string;
  description: string;
  inputs: readonly ProfileInput[];
}

export interface ProfileBlock {
  profile: VolumeProfile;
  /** Time span (UTC ms) the histogram is drawn inside, for span-anchored modes. */
  t0: number;
  t1: number;
  /** How its POC and value area developed through the period (the "Developing" option). */
  developing?: DevelopingProfile;
}

/**
 * What the renderer consumes. `right` = one histogram on the right edge of the pane;
 * `span` = each histogram drawn from its own t0 rightwards inside [t0, t1]. `naked`: POCs price has not
 * revisited, drawn on until touched. `notice`: why nothing is drawn (TPO on bars coarser than its bracket).
 */
export type ProfileRenderModel =
  | {
      kind: 'volume';
      anchor: 'right' | 'span';
      blocks: ProfileBlock[];
      naked?: NakedPoc[];
      notice?: string;
    }
  | { kind: 'tpo'; sessions: TpoProfile[]; notice?: string };

/** What the chart adds to the bars: where its own bars open (the developing lines step there). */
export interface ProfileContext {
  /** The chart's bar open times (UTC ms), ascending. */
  checkpoints?: readonly number[];
  /**
   * The bars handed in are LOWER-timeframe bars of the chart's range (DR-I7) — their interval, ms. 0 / absent: the
   * chart's own bars.
   */
  lowerTimeframeMs?: number;
}

const ROWS: IndicatorInput = {
  key: 'rows',
  label: 'Row count',
  type: 'number',
  default: 24,
  min: 2,
  max: 500,
};
const TICK: IndicatorInput = {
  key: 'tickSize',
  label: 'Row size (price, 0 = use rows)',
  type: 'number',
  default: 0,
  min: 0,
};
const VA: IndicatorInput = {
  key: 'valueAreaPct',
  label: 'Value area %',
  type: 'number',
  default: 70,
  min: 1,
  max: 100,
};
const COMMON: readonly ProfileInput[] = [ROWS, TICK, VA];
const TV = 'FX volume is tick volume.';
const ON_OFF = ['Off', 'On'] as const;
const DEVELOPING: ProfileInput = {
  key: 'developing',
  label: 'Developing POC / VA',
  type: 'select',
  default: 'Off',
  options: ON_OFF,
};
const NAKED: ProfileInput = {
  key: 'nakedPoc',
  label: 'Naked POCs',
  type: 'select',
  default: 'Off',
  options: ON_OFF,
};

export const PROFILE_STUDIES: readonly ProfileStudyDef[] = [
  {
    id: 'vp-visible',
    name: 'Volume Profile Visible Range',
    description: `Profile of the visible bars (tick volume). ${TV}`,
    inputs: COMMON,
  },
  {
    id: 'vp-session',
    name: 'Session Volume Profile',
    description: `One profile per trading session (tick volume). ${TV}`,
    inputs: [
      {
        key: 'session',
        label: 'Session',
        type: 'select',
        default: 'daily',
        options: ['daily', 'asia', 'london', 'newyork'],
      },
      {
        key: 'tzOffsetMinutes',
        label: 'Daily session: clock offset from UTC (min)',
        type: 'number',
        default: 0,
        min: -720,
        max: 840,
      },
      DEVELOPING,
      NAKED,
      ...COMMON,
    ],
  },
  {
    id: 'vp-periodic',
    name: 'Periodic Volume Profile',
    description: `One profile per day / week / month (tick volume). ${TV}`,
    inputs: [
      {
        key: 'period',
        label: 'Period',
        type: 'select',
        default: 'day',
        options: ['day', 'week', 'month'],
      },
      DEVELOPING,
      NAKED,
      ...COMMON,
    ],
  },
  {
    id: 'vp-fixed',
    name: 'Fixed Range Volume Profile',
    description: `Profile between two times you pick on the chart (tick volume). ${TV}`,
    inputs: [
      { key: 'fromTime', label: 'From', type: 'time', default: 0 },
      { key: 'toTime', label: 'To', type: 'time', default: 0 },
      ...COMMON,
    ],
  },
  {
    id: 'vp-composite',
    name: 'Composite Volume Profile',
    description: `One profile of the last N trading days together (tick volume). ${TV}`,
    inputs: [
      { key: 'periods', label: 'Trading days', type: 'number', default: 5, min: 1, max: 260 },
      ...COMMON,
    ],
  },
  {
    id: 'vp-auto-anchored',
    name: 'Auto Anchored Volume Profile',
    description: `Profile from an automatic anchor to the last bar (tick volume). ${TV}`,
    inputs: [
      {
        key: 'anchor',
        label: 'Anchor',
        type: 'select',
        default: 'highestHigh',
        options: ['highestHigh', 'lowestLow', 'session', 'week'],
      },
      {
        key: 'lookback',
        label: 'Lookback (bars)',
        type: 'number',
        default: 100,
        min: 2,
        max: 5000,
      },
      ...COMMON,
    ],
  },
  {
    id: 'tpo',
    name: 'TPO Market Profile',
    description:
      'Time-price opportunity letters per bracket, daily sessions (time based, not volume).',
    inputs: [
      {
        key: 'bracketMinutes',
        label: 'Bracket (minutes)',
        type: 'number',
        default: 30,
        min: 1,
        max: 240,
      },
      {
        key: 'tzOffsetMinutes',
        label: 'Session clock offset from UTC (min)',
        type: 'number',
        default: 0,
        min: -720,
        max: 840,
      },
      ...COMMON,
    ],
  },
];

export type ProfileParams = Record<string, number | string>;

/** Defaults merged with overrides. */
export function profileStudyParams(id: ProfileStudyId, params: ProfileParams = {}): ProfileParams {
  const def = PROFILE_STUDIES.find((s) => s.id === id);
  const out: ProfileParams = {};
  for (const inp of def?.inputs ?? [])
    out[inp.key] = (params[inp.key] ?? inp.default) as number | string;
  return out;
}

function baseOpts(p: ProfileParams): ProfileOptions {
  const tick = Number(p['tickSize']) || 0;
  return {
    rows: Number(p['rows']) || 24,
    tickSize: tick > 0 ? tick : undefined,
    valueAreaPct: Number(p['valueAreaPct']) || 70,
    upDown: true,
  };
}

/**
 * Compute the render model for a profile study. `visibleRange` = logical bar indices
 * (from the time scale's getVisibleLogicalRange()); only vp-visible needs it, and it falls
 * back to all bars when absent. `days`: the symbol's trading days, which the daily sessions,
 * periods and anchors count in (UTC days without them).
 */
export function computeProfileStudy(
  id: ProfileStudyId,
  bars: readonly Ohlc[],
  params: ProfileParams = {},
  visibleRange?: { from: number; to: number } | null,
  days?: TradingDays,
  ctx: ProfileContext = {},
): ProfileRenderModel {
  const p = profileStudyParams(id, params);
  const o = baseOpts(p);
  // Period profiles with the Developing and Naked POC options.
  const periods = (list: SessionProfile[]): ProfileRenderModel => ({
    kind: 'volume',
    anchor: 'span',
    blocks: list.map((s) => ({
      profile: s.profile,
      t0: s.profile.t0,
      t1: s.profile.t1,
      ...(p['developing'] === 'On'
        ? { developing: developingProfile(bars, s.startIdx, s.endIdx, ctx.checkpoints ?? [], o) }
        : {}),
    })),
    ...(p['nakedPoc'] === 'On' ? { naked: nakedPocs(bars, list) } : {}),
  });
  const one = (vp: VolumeProfile | null, anchor: 'right' | 'span'): ProfileRenderModel => ({
    kind: 'volume',
    anchor,
    blocks: vp ? [{ profile: vp, t0: vp.t0, t1: vp.t1 }] : [],
  });
  switch (id) {
    case 'vp-visible': {
      const from = visibleRange ? visibleRange.from : 0;
      const to = visibleRange ? visibleRange.to : bars.length - 1;
      return one(visibleRangeProfile(bars, from, to, o), 'right');
    }
    case 'vp-session':
      return periods(
        sessionProfiles(bars, {
          ...o,
          session: String(p['session']) as SessionName,
          tzOffsetMinutes: Number(p['tzOffsetMinutes']) || 0,
          days,
        }),
      );
    case 'vp-periodic':
      return periods(
        periodicProfiles(bars, { ...o, period: String(p['period']) as ProfilePeriod, days }),
      );
    case 'vp-fixed': {
      const a = Number(p['fromTime']) || (bars[0]?.time ?? 0);
      const b = Number(p['toTime']) || (bars[bars.length - 1]?.time ?? 0);
      return one(fixedRangeProfile(bars, a, b, o), 'span');
    }
    case 'vp-composite':
      return one(
        compositeProfile(bars, { ...o, periods: Number(p['periods']) || 5, days }),
        'span',
      );
    case 'vp-auto-anchored':
      return one(
        autoAnchoredProfile(bars, {
          ...o,
          anchor: String(p['anchor']) as AutoAnchor,
          lookback: Number(p['lookback']) || 100,
          days,
        }),
        'span',
      );
    case 'tpo': {
      // A TPO letter is a bracket's worth of trading: bars wider than the bracket cannot say which brackets traded
      // at a price (an H1 bar spans two 30-minute letters; an H4 bar eight), so TPO refuses them (DR-20).
      const bracket = (Number(p['bracketMinutes']) || 30) * 60_000;
      const interval = ctx.lowerTimeframeMs || barIntervalOf(bars);
      if (interval > bracket) {
        return {
          kind: 'tpo',
          sessions: [],
          notice:
            `TPO needs bars of ${bracket / 60_000} minutes or less; this chart's are ${Math.round(interval / 60_000)} ` +
            'minutes and no finer data was loaded. Use a lower timeframe or a longer bracket.',
        };
      }
      return {
        kind: 'tpo',
        sessions: tpoProfile(bars, {
          bracketMinutes: Number(p['bracketMinutes']) || 30,
          tzOffsetMinutes: Number(p['tzOffsetMinutes']) || 0,
          rows: o.rows,
          tickSize: o.tickSize,
          valueAreaPct: o.valueAreaPct,
          days,
        }),
      };
    }
  }
}

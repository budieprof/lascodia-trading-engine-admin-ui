import type { TradingDays } from '../datafeed/session-calendar';
import type { Ohlc } from '../indicators/math';
import type { IndicatorInput } from '../indicators/registry';
import {
  autoAnchoredProfile,
  fixedRangeProfile,
  periodicProfiles,
  sessionProfiles,
  tpoProfile,
  visibleRangeProfile,
  type AutoAnchor,
  type ProfileOptions,
  type ProfilePeriod,
  type SessionName,
  type TpoProfile,
  type VolumeProfile,
} from './profile-math';

/** IndicatorInput plus a select type for enum parameters (session, period, anchor). */
export type ProfileInput =
  | IndicatorInput
  | { key: string; label: string; type: 'select'; default: string; options: readonly string[] };

export type ProfileStudyId = 'vp-visible' | 'vp-session' | 'vp-periodic' | 'vp-fixed' | 'vp-auto-anchored' | 'tpo';

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
}

/**
 * What the renderer consumes. `right` = one histogram on the right edge of the pane;
 * `span` = each histogram drawn from its own t0 rightwards inside [t0, t1].
 */
export type ProfileRenderModel =
  | { kind: 'volume'; anchor: 'right' | 'span'; blocks: ProfileBlock[] }
  | { kind: 'tpo'; sessions: TpoProfile[] };

const ROWS: IndicatorInput = { key: 'rows', label: 'Row count', type: 'number', default: 24, min: 2, max: 500 };
const TICK: IndicatorInput = { key: 'tickSize', label: 'Row size (price, 0 = use rows)', type: 'number', default: 0, min: 0 };
const VA: IndicatorInput = { key: 'valueAreaPct', label: 'Value area %', type: 'number', default: 70, min: 1, max: 100 };
const COMMON: readonly ProfileInput[] = [ROWS, TICK, VA];
const TV = 'FX volume is tick volume.';

export const PROFILE_STUDIES: readonly ProfileStudyDef[] = [
  { id: 'vp-visible', name: 'Volume Profile Visible Range', description: `Profile of the visible bars (tick volume). ${TV}`, inputs: COMMON },
  {
    id: 'vp-session',
    name: 'Session Volume Profile',
    description: `One profile per trading session (tick volume). ${TV}`,
    inputs: [
      { key: 'session', label: 'Session', type: 'select', default: 'daily', options: ['daily', 'asia', 'london', 'newyork'] },
      { key: 'tzOffsetMinutes', label: 'Session clock offset from UTC (min)', type: 'number', default: 0, min: -720, max: 840 },
      ...COMMON,
    ],
  },
  {
    id: 'vp-periodic',
    name: 'Periodic Volume Profile',
    description: `One profile per day / week / month (tick volume). ${TV}`,
    inputs: [{ key: 'period', label: 'Period', type: 'select', default: 'day', options: ['day', 'week', 'month'] }, ...COMMON],
  },
  {
    id: 'vp-fixed',
    name: 'Fixed Range Volume Profile',
    description: `Profile between two times (tick volume). ${TV}`,
    inputs: [
      { key: 'fromTime', label: 'From (UTC ms)', type: 'number', default: 0 },
      { key: 'toTime', label: 'To (UTC ms)', type: 'number', default: 0 },
      ...COMMON,
    ],
  },
  {
    id: 'vp-auto-anchored',
    name: 'Auto Anchored Volume Profile',
    description: `Profile from an automatic anchor to the last bar (tick volume). ${TV}`,
    inputs: [
      { key: 'anchor', label: 'Anchor', type: 'select', default: 'highestHigh', options: ['highestHigh', 'lowestLow', 'session', 'week'] },
      { key: 'lookback', label: 'Lookback (bars)', type: 'number', default: 100, min: 2, max: 5000 },
      ...COMMON,
    ],
  },
  {
    id: 'tpo',
    name: 'TPO Market Profile',
    description: 'Time-price opportunity letters per bracket, daily sessions (time based, not volume).',
    inputs: [
      { key: 'bracketMinutes', label: 'Bracket (minutes)', type: 'number', default: 30, min: 1, max: 240 },
      { key: 'tzOffsetMinutes', label: 'Session clock offset from UTC (min)', type: 'number', default: 0, min: -720, max: 840 },
      ...COMMON,
    ],
  },
];

export type ProfileParams = Record<string, number | string>;

/** Defaults merged with overrides. */
export function profileStudyParams(id: ProfileStudyId, params: ProfileParams = {}): ProfileParams {
  const def = PROFILE_STUDIES.find((s) => s.id === id);
  const out: ProfileParams = {};
  for (const inp of def?.inputs ?? []) out[inp.key] = (params[inp.key] ?? inp.default) as number | string;
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
): ProfileRenderModel {
  const p = profileStudyParams(id, params);
  const o = baseOpts(p);
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
      return {
        kind: 'volume',
        anchor: 'span',
        blocks: sessionProfiles(bars, {
          ...o,
          session: String(p['session']) as SessionName,
          tzOffsetMinutes: Number(p['tzOffsetMinutes']) || 0,
          days,
        }).map((s) => ({ profile: s.profile, t0: s.profile.t0, t1: s.profile.t1 })),
      };
    case 'vp-periodic':
      return {
        kind: 'volume',
        anchor: 'span',
        blocks: periodicProfiles(bars, { ...o, period: String(p['period']) as ProfilePeriod, days }).map((s) => ({
          profile: s.profile,
          t0: s.profile.t0,
          t1: s.profile.t1,
        })),
      };
    case 'vp-fixed': {
      const a = Number(p['fromTime']) || (bars[0]?.time ?? 0);
      const b = Number(p['toTime']) || (bars[bars.length - 1]?.time ?? 0);
      return one(fixedRangeProfile(bars, a, b, o), 'span');
    }
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
    case 'tpo':
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

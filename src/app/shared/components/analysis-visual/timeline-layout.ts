import type { VisualSpec, VisualTimelineEvent, VisualTimelineWindow } from './visual-spec';

/**
 * Pure layout for the `timeline` chart — kept out of the component so it can be tested without
 * a DOM.
 *
 * <p>The first strip pinned each event's full label under its tick. A calendar clusters: in
 * conversation #33534 five events fell inside three hours of one Tuesday, and their labels
 * printed on top of each other until none could be read. So the strip now carries only a
 * NUMBERED marker per event, stacked into lanes so two markers never overlap, and the words go
 * in an agenda under it where they have a full line each.</p>
 */

export interface LaidEvent extends VisualTimelineEvent {
  /** 1-based, in time order — the number on the marker and in the agenda. */
  n: number;
  ms: number;
  leftPct: number;
  /** Row the marker sits in; 0 is the top. */
  lane: number;
  /** "12:15Z". */
  time: string;
}

export interface LaidWindow extends VisualTimelineWindow {
  leftPct: number;
  widthPct: number;
  /** "9/21 20:30Z → 9/22 20:04Z". */
  range: string;
}

export interface DaySegment {
  leftPct: number;
  widthPct: number;
  /** "Tue 22", shortened or blank when the segment is too narrow to hold it. */
  label: string;
}

export interface AgendaDay {
  /** "Tue 22 Sep". */
  day: string;
  events: LaidEvent[];
}

export interface TimelineLayout {
  events: LaidEvent[];
  lanes: number;
  windows: LaidWindow[];
  /** Positions of UTC midnights inside the span — the day gridlines. */
  midnights: number[];
  days: DaySegment[];
  agenda: AgendaDay[];
}

/** Marker diameter plus breathing room, in px. Two markers closer than this share no lane. */
export const MARKER_GAP_PX = 24;
/** Past this many lanes the strip would be taller than it is informative; extra markers share. */
export const MAX_LANES = 4;

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function layoutTimeline(spec: VisualSpec, widthPx: number): TimelineLayout {
  const rawEvents = (spec.events ?? [])
    .map((e) => ({ e, ms: Date.parse(e.at) }))
    .filter((x) => Number.isFinite(x.ms))
    .sort((a, b) => a.ms - b.ms);
  const rawWindows = (spec.windows ?? [])
    .map((w) => ({ w, from: Date.parse(w.from), to: Date.parse(w.to) }))
    .filter((x) => Number.isFinite(x.from) && Number.isFinite(x.to));

  const stamps = [
    ...rawEvents.map((x) => x.ms),
    ...rawWindows.flatMap((x) => [x.from, x.to]),
    ...[spec.from, spec.to].map((s) => (s ? Date.parse(s) : NaN)),
  ].filter((n) => Number.isFinite(n));

  if (stamps.length === 0) {
    return { events: [], lanes: 0, windows: [], midnights: [], days: [], agenda: [] };
  }

  let from = Math.min(...stamps);
  let to = Math.max(...stamps);
  // A single-instant timeline would divide by zero; give it an hour of air either side.
  if (to <= from) {
    from -= 3.6e6;
    to += 3.6e6;
  }
  // Pad so a marker on the first or last instant is not cut in half by the strip's edge.
  const pad = (to - from) * 0.025;
  from -= pad;
  to += pad;

  const pct = (ms: number): number => Math.max(0, Math.min(100, ((ms - from) / (to - from)) * 100));

  // Greedy lane packing, left to right: each marker takes the first lane whose previous marker is
  // far enough away. When every lane is crowded it joins the one that has been free longest —
  // overlap there beats a strip that grows without bound.
  const gapPct = (MARKER_GAP_PX / Math.max(widthPx, 1)) * 100;
  const laneEnd: number[] = [];
  const events: LaidEvent[] = rawEvents.map(({ e, ms }, i) => {
    const leftPct = pct(ms);
    let lane = laneEnd.findIndex((end) => leftPct - end >= gapPct);
    if (lane < 0) {
      if (laneEnd.length < MAX_LANES) lane = laneEnd.length;
      else lane = laneEnd.indexOf(Math.min(...laneEnd));
    }
    laneEnd[lane] = leftPct;
    return { ...e, n: i + 1, ms, leftPct, lane, time: hhmm(ms) };
  });

  const windows: LaidWindow[] = rawWindows.map(({ w, from: f, to: t }) => {
    const l = pct(f);
    return {
      ...w,
      leftPct: l,
      widthPct: Math.max(0.5, pct(t) - l),
      range: `${stamp(f)} → ${stamp(t)}`,
    };
  });

  const midnightMs: number[] = [];
  for (let m = Math.ceil(from / DAY_MS) * DAY_MS; m < to; m += DAY_MS) midnightMs.push(m);
  const midnights = midnightMs.map(pct);

  // One segment per calendar day the span touches, labelled at its centre when it fits.
  const bounds = [from, ...midnightMs, to];
  const days: DaySegment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const leftPct = pct(bounds[i]);
    const widthPct = pct(bounds[i + 1]) - leftPct;
    const px = (widthPct / 100) * widthPx;
    const d = new Date(bounds[i]);
    const label =
      px >= 52
        ? `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`
        : px >= 20
          ? String(d.getUTCDate())
          : '';
    days.push({ leftPct, widthPct, label });
  }

  const agenda: AgendaDay[] = [];
  for (const ev of events) {
    const d = new Date(ev.ms);
    const day = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    const last = agenda[agenda.length - 1];
    if (last && last.day === day) last.events.push(ev);
    else agenda.push({ day, events: [ev] });
  }

  return { events, lanes: laneEnd.length, windows, midnights, days, agenda };
}

const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
};

const stamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hhmm(ms)}`;
};

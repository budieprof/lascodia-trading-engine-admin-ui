import type { NamedSession } from './analysis-overlays';
import type {
  StructureBasis,
  StructureLevel,
  StructureMarker,
  StructureZone,
} from './market-structure';

/**
 * "How was this computed?" for every layer the chart DERIVES from its bars (PR-4): the structure read,
 * the profiles, support and resistance, auto analysis. Hovering one shows its method and inputs in plain
 * words. The text lives here, in one place, so a renderer never writes its own (and a spec can check that
 * every derived label has an entry).
 *
 * <p>Honesty first: spot FX has no consolidated tape, so "volume" is TICK volume (quote count), and the
 * stop pools are an assumption about where stops rest, not data about them. Every entry says so where
 * it applies.</p>
 */

export type ProvenanceKey =
  | 'structure.balance'
  | 'structure.rangeHigh'
  | 'structure.rangeLow'
  | 'structure.pool'
  | 'structure.value'
  | 'structure.poc'
  | 'structure.vah'
  | 'structure.val'
  | 'structure.spring'
  | 'structure.upthrust'
  | 'structure.climax'
  | 'structure.last'
  | 'profile.visible'
  | 'profile.period'
  | 'profile.session'
  | 'profile.poc'
  | 'profile.vah'
  | 'profile.val'
  | 'profile.npoc'
  | 'profile.developing'
  | 'sr.level'
  | 'auto.trendline'
  | 'auto.htf'
  | 'auto.fib';

/** What a drawn element knows about how it was computed; each entry reads the facts it needs. */
export interface ProvenanceFacts {
  structure?: StructureBasis | null;
  /** Bars profiled / read. */
  bars?: number;
  /** Profile rows. */
  rows?: number;
  /** The period: "Mon 20 Oct", "London 20 Oct". */
  label?: string;
  session?: NamedSession;
  /** A naked POC: when it was first traded through (null: still naked). */
  touched?: boolean;
  touches?: number;
  score?: number;
  timeframe?: string;
  ratio?: number;
  /** The zig-zag's reversal threshold, percent. */
  deviation?: number;
}

export interface Provenance {
  title: string;
  /** Method and inputs, one sentence a line. */
  lines: string[];
  /** Drawn from an assumption rather than data (the stop pools): the card says "Estimate". */
  estimate: boolean;
}

const TICK_VOLUME =
  'Volume is tick volume — the number of quotes per bar, not traded lots: spot FX has no consolidated tape. ' +
  'Each bar’s count is spread evenly over its high–low range.';
const ON_SCREEN = 'Read from the chart’s own bars on screen, nothing fetched; it changes as you pan or zoom.';

const SESSION_HOURS: Readonly<Record<NamedSession, string>> = {
  asia: 'Tokyo 09:00–18:00',
  london: 'London 08:00–17:00',
  newyork: 'New York 08:00–17:00',
};

function n(value: number | undefined, digits = 0): string {
  return value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

/** ATR and a multiple of it in pips: "6 × ATR(14) ≈ 52 pips". */
function inPips(mult: number, b: StructureBasis): string {
  const pips = b.pip > 0 ? (mult * b.atr) / b.pip : Number.NaN;
  return `${mult} × ATR(14) ≈ ${n(pips, pips < 10 ? 1 : 0)} pips`;
}

function bars(f: ProvenanceFacts): string {
  const b = f.structure?.bars ?? f.bars;
  return b === undefined ? 'the bars on screen' : `the ${b} bars on screen`;
}

function balanceLine(f: ProvenanceFacts): string {
  const b = f.structure;
  if (!b) return 'The stretch back from the newest bar whose total high–low range stays inside a multiple of ATR(14).';
  return (
    `The stretch back from the newest bar whose total high–low range stays within ${inPips(b.balanceAtr, b)}` +
    (b.balanceBars !== null ? ` — ${b.balanceBars} bars here` : '') +
    ` (at least ${b.minBalanceBars} bars to count as a balance).`
  );
}

function profileLevel(what: string, f: ProvenanceFacts): string[] {
  const of = f.label ? `the ${f.label} profile` : `the profile of ${bars(f)}`;
  return [`${what} of ${of}${f.rows ? `, ${f.rows} price rows` : ''}.`, TICK_VOLUME];
}

/** Every derived layer's method and inputs. Typed as a full record: a new key without text does not compile. */
export const PROVENANCE: { readonly [K in ProvenanceKey]: (f: ProvenanceFacts) => Provenance } = {
  'structure.balance': (f) => ({
    title: 'Balance range',
    lines: [balanceLine(f), ON_SCREEN],
    estimate: false,
  }),
  'structure.rangeHigh': (f) => ({
    title: 'Range high',
    lines: ['The highest high inside the balance range.', balanceLine(f), ON_SCREEN],
    estimate: false,
  }),
  'structure.rangeLow': (f) => ({
    title: 'Range low',
    lines: ['The lowest low inside the balance range.', balanceLine(f), ON_SCREEN],
    estimate: false,
  }),
  'structure.pool': (f) => ({
    title: 'Stop pool (estimate)',
    lines: [
      f.structure
        ? `An estimate, not stop data: a band ${inPips(f.structure.poolAtr, f.structure)} beyond the range edge, where stops are conventionally assumed to rest.`
        : 'An estimate, not stop data: a band a fraction of ATR(14) beyond the range edge, where stops are conventionally assumed to rest.',
      'Nobody publishes where stops are — this is placed by the range, not measured.',
    ],
    estimate: true,
  }),
  'structure.value': (f) => ({
    title: 'Value area',
    lines: [
      `The band of price rows around the POC that holds 70% of the tick volume of ${bars(f)}, grown one row at a time toward the busier side.`,
      TICK_VOLUME,
    ],
    estimate: false,
  }),
  'structure.poc': (f) => ({
    title: 'Point of control (POC)',
    lines: [`The price row with the most tick volume in ${bars(f)}.`, TICK_VOLUME],
    estimate: false,
  }),
  'structure.vah': (f) => ({
    title: 'Value area high (VAH)',
    lines: [`The top of the band holding 70% of the tick volume of ${bars(f)}.`, TICK_VOLUME],
    estimate: false,
  }),
  'structure.val': (f) => ({
    title: 'Value area low (VAL)',
    lines: [`The bottom of the band holding 70% of the tick volume of ${bars(f)}.`, TICK_VOLUME],
    estimate: false,
  }),
  'structure.spring': (f) => ({
    title: 'Spring',
    lines: [
      'A bar that traded below the balance’s low so far and closed back above it; only the deepest one is marked.',
      balanceLine(f),
    ],
    estimate: false,
  }),
  'structure.upthrust': (f) => ({
    title: 'Upthrust',
    lines: [
      'A bar that traded above the balance’s high so far and closed back below it; only the highest one is marked.',
      balanceLine(f),
    ],
    estimate: false,
  }),
  'structure.climax': (f) => ({
    title: 'Climax bar',
    lines: [
      f.structure
        ? `Range AND tick volume both more than ${f.structure.climaxMult} × their average over the previous ${f.structure.climaxWindow} bars; selling if it closed down, buying if up.`
        : 'Range and tick volume both far above their recent average.',
      'Tick volume counts quotes, not traded lots.',
    ],
    estimate: false,
  }),
  'structure.last': () => ({
    title: 'Last price',
    lines: ['The close of the newest bar.'],
    estimate: false,
  }),
  'profile.visible': (f) => ({
    title: 'Volume profile — visible range',
    lines: [
      `Tick volume by price of ${bars(f)}${f.rows ? `, in ${f.rows} rows` : ''}; re-profiled as you pan.`,
      TICK_VOLUME,
    ],
    estimate: false,
  }),
  'profile.period': (f) => ({
    title: `Volume profile — ${f.label ?? 'period'}`,
    lines: [
      `Tick volume by price of ${f.bars ? `the ${f.bars} bars` : 'the bars'} of ${f.label ?? 'the period'} (the symbol’s trading day, week or month)${f.rows ? `, ${f.rows} rows` : ''}.`,
      TICK_VOLUME,
    ],
    estimate: false,
  }),
  'profile.session': (f) => ({
    title: `Session profile — ${f.label ?? 'session'}`,
    lines: [
      `Tick volume by price of ${f.bars ? `the ${f.bars} bars` : 'the bars'} inside ${f.session ? SESSION_HOURS[f.session] : 'the session'} local time (daylight saving included)${f.rows ? `, ${f.rows} rows` : ''}.`,
      'Sessions overlap (London and New York share four hours), so a bar can count in two.',
      TICK_VOLUME,
    ],
    estimate: false,
  }),
  'profile.poc': (f) => ({
    title: 'Point of control (POC)',
    lines: profileLevel('The busiest price row', f),
    estimate: false,
  }),
  'profile.vah': (f) => ({
    title: 'Value area high (VAH)',
    lines: profileLevel('The top of the band holding 70% of the tick volume', f),
    estimate: false,
  }),
  'profile.val': (f) => ({
    title: 'Value area low (VAL)',
    lines: profileLevel('The bottom of the band holding 70% of the tick volume', f),
    estimate: false,
  }),
  'profile.npoc': (f) => ({
    title: `${f.touched ? 'POC' : 'Naked POC'}${f.label ? ` ${f.label}` : ''}${f.touched ? ' — touched' : ''}`,
    lines: [
      `The POC of ${f.label ?? 'a finished period'}${f.bars ? ` (${f.bars} bars)` : ''}.`,
      f.touched
        ? 'A later bar traded through it; the line stops at that bar.'
        : 'No later bar has traded through it yet, so it is carried right until one does.',
      'The last 10 finished periods are shown.',
    ],
    estimate: false,
  }),
  'profile.developing': (f) => ({
    title: `Developing POC / VA — ${f.label ?? 'period'}`,
    lines: [
      `Where the POC, VAH and VAL of ${f.label ?? 'the period'} stood after each bar, using only the bars up to it.`,
      TICK_VOLUME,
    ],
    estimate: false,
  }),
  'sr.level': (f) => ({
    title: 'Support / resistance',
    lines: [
      `${f.touches ?? 'Several'} swing pivots (a high or low that is the extreme of 7 bars) within 0.5 × ATR(14) of each other.`,
      'Levels closer than 1.5 × ATR to a stronger one are dropped; line weight is touches and recency.',
      ON_SCREEN,
    ],
    estimate: false,
  }),
  'auto.trendline': (f) => ({
    title: 'Auto trendline',
    lines: [
      'A line through two swing highs (or lows, 5 bars each side) that no close has broken by more than 0.1 × ATR(14) since its first anchor.',
      `${f.touches ?? 'Its'} swings lie within 0.25 × ATR of it; score ${n(f.score, 1)} = touches + how long it has held + how recently it was touched.`,
      ON_SCREEN,
    ],
    estimate: false,
  }),
  'auto.htf': (f) => ({
    title: `${f.timeframe ?? 'Higher timeframe'} support / resistance`,
    lines: [
      `The swing-pivot S/R levels of the last 150 ${f.timeframe ?? 'higher-timeframe'} bars, clustered as the S/R overlay is.`,
      `${f.touches ?? 'Several'} pivots formed this one.`,
    ],
    estimate: false,
  }),
  'auto.fib': (f) => ({
    title: f.ratio === undefined ? 'Auto Fib' : `Auto Fib ${f.ratio}`,
    lines: [
      `Fibonacci ${f.ratio ?? 'level'} of the last zig-zag leg (0 at its end, 1 at its start); a swing counts when price reverses ${n(f.deviation, 2)}% (≈ 3 × ATR).`,
      'The last leg is provisional: it moves while price extends it.',
    ],
    estimate: false,
  }),
};

/** The card for `key`. */
export function provenanceOf(key: ProvenanceKey, facts: ProvenanceFacts = {}): Provenance {
  return PROVENANCE[key](facts);
}

/** Which entry explains a structure level (by its kind and label). */
export function structureLevelKey(level: StructureLevel): ProvenanceKey {
  switch (level.kind) {
    case 'live':
      return 'structure.last';
    case 'pool':
      return 'structure.pool';
    case 'structure':
      return level.label === 'Range low' ? 'structure.rangeLow' : 'structure.rangeHigh';
    case 'value':
      return level.label === 'POC' ? 'structure.poc' : level.label === 'VAL' ? 'structure.val' : 'structure.vah';
  }
}

export function structureZoneKey(zone: StructureZone): ProvenanceKey {
  switch (zone.kind) {
    case 'balance':
      return 'structure.balance';
    case 'value':
      return 'structure.value';
    case 'pool':
      return 'structure.pool';
  }
}

export function structureMarkerKey(marker: StructureMarker): ProvenanceKey {
  switch (marker.kind) {
    case 'climax':
      return 'structure.climax';
    case 'spring':
      return 'structure.spring';
    case 'upthrust':
      return 'structure.upthrust';
  }
}

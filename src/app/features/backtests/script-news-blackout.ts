/**
 * The engine's high-impact news blackout as a script backtest modelled it — `resultJson.script.newsBlackout`
 * (engine `ScriptNewsBlackoutInfo`, 2026-10-01). Live, the Tier-1 bridge refuses an entry inside the
 * window unless the strategy holds the news-blackout exemption; the script backtest does the same by
 * leaving those trades out of the engine's trade list, balance and metrics while its emulator (and
 * the embedded Pine report) still takes them. Absent on results stored before 2026-10-01.
 */
export interface ScriptNewsBlackout {
  /** The window was active for this strategy. */
  applied: boolean;
  /** Not applied because the strategy holds the audited exemption. */
  exempt: boolean;
  /** False only when the run could not resolve the policy (a test harness, never production). */
  modelled: boolean;
  minutesBefore: number;
  minutesAfter: number;
  /** Why the window looks the way it does (config / Viability Gates page / exemption). */
  explanation: string;
  /** High-impact events for the symbol's currencies in the run's span (0 unless applied). */
  events: number;
  /** Entries inside the window, left out of the engine's trades and metrics. */
  blockedEntries: number;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A property by its camelCase name, tolerating PascalCase. */
function prop(o: Json, camel: string): unknown {
  if (camel in o) return o[camel];
  return o[camel[0].toUpperCase() + camel.slice(1)];
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

/** The run's `script.newsBlackout`, or null when it has none (older runs, non-script runs, bad JSON). */
export function scriptNewsBlackoutOf(
  resultJson: string | null | undefined,
): ScriptNewsBlackout | null {
  if (!resultJson) return null;
  let root: unknown;
  try {
    root = JSON.parse(resultJson);
  } catch {
    return null;
  }
  if (!isObject(root)) return null;
  const script = prop(root, 'script');
  if (!isObject(script)) return null;
  const nb = prop(script, 'newsBlackout');
  if (!isObject(nb)) return null;
  const explanation = prop(nb, 'explanation');
  return {
    applied: prop(nb, 'applied') === true,
    exempt: prop(nb, 'exempt') === true,
    modelled: prop(nb, 'modelled') === true,
    minutesBefore: count(prop(nb, 'minutesBefore')),
    minutesAfter: count(prop(nb, 'minutesAfter')),
    explanation: typeof explanation === 'string' ? explanation.trim() : '',
    events: count(prop(nb, 'events')),
    blockedEntries: count(prop(nb, 'blockedEntries')),
  };
}

export type NewsBlackoutTone = 'applied' | 'exempt' | 'off' | 'unmodelled';

/** What the backtest detail page shows for a run's news blackout. */
export interface NewsBlackoutSummary {
  tone: NewsBlackoutTone;
  /** Short status for the pill: Applied / Exempt / Off / Not modelled. */
  status: string;
  /** The window around each release, e.g. "30 min before / 15 min after" — only when applied. */
  window: string | null;
  /** One sentence on what it did to this run. */
  effect: string;
  /** The engine's own explanation, for the expander; empty when it sent none. */
  explanation: string;
  /** Added when entries were removed: why the Pine report still shows them. */
  reportNote: string | null;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function summarizeNewsBlackout(nb: ScriptNewsBlackout): NewsBlackoutSummary {
  const base = { explanation: nb.explanation, reportNote: null, window: null };
  if (!nb.modelled) {
    return {
      ...base,
      tone: 'unmodelled',
      status: 'Not modelled',
      effect: 'This run could not resolve the news-blackout policy, so it blocked nothing.',
    };
  }
  if (nb.exempt) {
    return {
      ...base,
      tone: 'exempt',
      status: 'Exempt',
      effect:
        'Not applied: the strategy is news-blackout exempt, so entries inside the window were kept — as live, paper and the EA let them through.',
    };
  }
  if (!nb.applied) {
    return {
      ...base,
      tone: 'off',
      status: 'Off',
      effect: 'The blackout was off when this run executed — live applies none either.',
    };
  }
  const removed =
    nb.blockedEntries === 0
      ? 'no entry fell inside it'
      : `${plural(nb.blockedEntries, 'entry', 'entries')} live would refuse ${nb.blockedEntries === 1 ? 'was' : 'were'} removed`;
  return {
    ...base,
    tone: 'applied',
    status: 'Applied',
    window: `${nb.minutesBefore} min before / ${nb.minutesAfter} min after`,
    effect: `Modelled as live applies it around ${plural(nb.events, 'High-impact event', 'High-impact events')}: ${removed}.`,
    reportNote:
      nb.blockedEntries > 0
        ? 'Removed entries are left out of the engine’s trades, balance and metrics. The emulator still took them (as the live session’s does), so the Strategy report includes them.'
        : null,
  };
}

import type { SignalStory, SignalStoryEvent, SignalStoryOrigin } from './signal-story.types';

/** The id range the engine holds, as shown on a "no such signal" page. */
export interface SignalRange {
  totalSignals: number | null;
  earliestId: number | null;
  earliestGeneratedAt: string | null;
  latestId: number | null;
  previousId: number | null;
  nextId: number | null;
}

/** One plain sentence saying why a signal id has nothing to show. */
export function missingSignalSentence(id: number, r: SignalRange): string {
  if (r.earliestId == null || r.latestId == null) {
    return `Signal #${id} does not exist, and the engine holds no signals at all yet.`;
  }
  const since = r.earliestGeneratedAt
    ? ` (generated ${new Date(r.earliestGeneratedAt).toUTCString().slice(5, 16)})`
    : '';
  if (id < r.earliestId) {
    return `Signal #${id} does not exist. The oldest signal this engine still holds is #${r.earliestId}${since}; ids below it were never created on this database or were removed before it was set up.`;
  }
  if (id > r.latestId) {
    return `Signal #${id} has not been created yet — the newest signal is #${r.latestId}.`;
  }
  return `Signal #${id} does not exist: that id was skipped or the row was deleted. Signals run from #${r.earliestId}${since} to #${r.latestId}.`;
}

/** Plain-language heading for where the signal came from. */
export function originHeading(o: SignalStoryOrigin): string {
  switch (o.kind) {
    case 'recommendation':
      return `Recommendation #${o.recommendationId}`;
    case 'patient-plan':
      return `Patient Trader plan #${o.patientTraderPlanId}`;
    case 'parked-rec':
      return `Parked recommendation #${o.pendingSignalRecId}`;
    case 'analyser-decision':
      return `Analyser decision #${o.analyserDecisionId}`;
    default:
      return 'Origin';
  }
}

/** Route for the origin's own page, when the console has one. */
export function originRoute(o: SignalStoryOrigin): string | null {
  if (o.recommendationId != null) return `/trade-recommendations/${o.recommendationId}`;
  if (o.patientTraderPlanId != null) return '/patient-trader';
  if (o.pendingSignalRecId != null) return '/pending-signal-recs';
  return null;
}

/** Short sentence for the outcome tile: what became of the signal. */
export function outcomeSentence(s: SignalStory): {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
} {
  const c = s.counts;
  if (c.ordersFilled > 0) {
    const pnl = c.realizedPnL;
    if (c.positionsOpen > 0)
      return { text: `Filled · ${c.positionsOpen} position(s) open`, tone: 'neutral' };
    return {
      text: `Filled · realised ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
      tone: pnl >= 0 ? 'ok' : 'bad',
    };
  }
  if (c.orders > 0) return { text: `${c.orders} order(s), none filled`, tone: 'warn' };
  if (c.engineRejections > 0) return { text: 'Refused by the engine', tone: 'bad' };
  if (c.accountsBlocked > 0 && c.accountsPassed === 0)
    return { text: 'Blocked on every account', tone: 'bad' };
  return { text: 'Never traded', tone: 'neutral' };
}

/** Timeline rows, newest last, with consecutive duplicates (same kind + title) folded. */
export function foldTimeline(
  events: SignalStoryEvent[],
): Array<SignalStoryEvent & { repeat: number }> {
  const out: Array<SignalStoryEvent & { repeat: number }> = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === e.kind && prev.title === e.title) {
      prev.repeat += 1;
      continue;
    }
    out.push({ ...e, repeat: 1 });
  }
  return out;
}

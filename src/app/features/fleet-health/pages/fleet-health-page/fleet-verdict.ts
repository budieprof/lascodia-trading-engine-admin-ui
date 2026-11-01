/**
 * The one-line answer to "is anything wrong with the fleet?" — built only from numbers the page
 * already shows in its tiles, so the headline can never disagree with them.
 */

export interface EaStats {
  total: number;
  active: number;
  disconnected: number;
  /** Disconnected with a heartbeat in the last 24 h — a live terminal that dropped, not history. */
  disconnectedRecent: number;
  /** ShuttingDown with a heartbeat inside the liveness window — a shutdown actually in flight. */
  shuttingDown: number;
  /** ShuttingDown and silent since: deregistered cleanly, finished. */
  deregistered: number;
  idleOverStale: number;
  coordinatorsLive: number;
  accounts: number;
  versions: number;
}

export type VerdictTone = 'ok' | 'warn' | 'bad';

export interface VerdictIssue {
  tone: 'warn' | 'bad';
  text: string;
}

export interface FleetVerdict {
  tone: VerdictTone;
  headline: string;
  /** Problems, worst first. Empty when healthy. */
  issues: VerdictIssue[];
  /** The healthy facts, shown when there are no issues. */
  facts: string[];
}

export interface VerdictInput {
  stats: EaStats | null;
  daemons: { online: number; total: number; offline: number } | null;
  dbLatencyMs: number | null;
  outboxPending: number | null;
  staleMinutes: number;
}

/** Same tiers as the Engine tile: < 50 ms fast, < 200 ms slow, else very slow. */
export function dbTier(ms: number): 'fast' | 'warn' | 'slow' {
  if (ms < 50) return 'fast';
  if (ms < 200) return 'warn';
  return 'slow';
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function fleetVerdict(x: VerdictInput): FleetVerdict {
  const issues: VerdictIssue[] = [];
  const s = x.stats;

  if (s === null) {
    issues.push({ tone: 'bad', text: 'EA instance list unavailable' });
  } else {
    if (s.disconnectedRecent > 0)
      issues.push({
        tone: 'bad',
        text: `${plural(s.disconnectedRecent, 'instance')} dropped in the last 24 h`,
      });
    if (s.active === 0) issues.push({ tone: 'warn', text: 'No EA instance is active' });
    if (s.idleOverStale > 0)
      issues.push({
        tone: 'warn',
        text: `${plural(s.idleOverStale, 'active instance')} silent for over ${x.staleMinutes} min`,
      });
    if (s.shuttingDown > 0)
      issues.push({ tone: 'warn', text: `${plural(s.shuttingDown, 'instance')} shutting down` });
  }
  if (x.daemons && x.daemons.offline > 0)
    issues.push({ tone: 'bad', text: `${plural(x.daemons.offline, 'daemon')} offline` });
  if (x.dbLatencyMs !== null) {
    const t = dbTier(x.dbLatencyMs);
    if (t !== 'fast')
      issues.push({
        tone: t === 'slow' ? 'bad' : 'warn',
        text: `Database latency ${Math.round(x.dbLatencyMs)} ms`,
      });
  }
  if (x.outboxPending !== null && x.outboxPending > 100)
    issues.push({ tone: 'warn', text: `${x.outboxPending} outbox messages pending` });

  issues.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'bad' ? -1 : 1));

  if (issues.length > 0) {
    const tone: VerdictTone = issues[0].tone;
    return {
      tone,
      headline: issues.length === 1 ? issues[0].text : `${issues.length} things need attention`,
      issues,
      facts: [],
    };
  }

  const facts: string[] = [];
  if (s) facts.push(`${s.active} of ${s.active} active instances heartbeating`);
  if (x.daemons) facts.push(`daemons ${x.daemons.online}/${x.daemons.total} online`);
  if (x.dbLatencyMs !== null) facts.push(`database ${Math.round(x.dbLatencyMs)} ms`);
  return { tone: 'ok', headline: 'Fleet healthy', issues: [], facts };
}

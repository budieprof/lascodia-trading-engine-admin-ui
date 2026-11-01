/**
 * Presentation helpers for the Terminals page: the fleet summary at the top, the session status
 * tones and the attention-first session order. Pure, tested.
 */
import type { TerminalDaemonDto, TerminalSessionDto } from '@core/api/api.types';

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

/** A session still holds an MT5 process (the daemon has not reported it stopped). */
export function isLiveSession(s: TerminalSessionDto): boolean {
  return s.stoppedAt === null;
}

/** Colour of a session status: Running is good, Starting/Stopping in flight, Crashed bad. */
export function sessionTone(status: string): Tone {
  switch (status) {
    case 'Running':
      return 'ok';
    case 'Starting':
    case 'Stopping':
      return 'warn';
    case 'Crashed':
      return 'bad';
    default:
      return 'muted';
  }
}

function sessionRank(s: TerminalSessionDto): number {
  if (s.status === 'Crashed') return 0;
  if (s.status === 'Starting' || s.status === 'Stopping') return 1;
  if (isLiveSession(s)) return 2;
  return 3;
}

/**
 * Sessions in the order an operator reads them: crashed first, then in-flight, then running,
 * then closed; newest launch first within each group. Returns a new array.
 */
export function orderSessions(sessions: readonly TerminalSessionDto[]): TerminalSessionDto[] {
  return [...sessions].sort((a, b) => {
    const r = sessionRank(a) - sessionRank(b);
    if (r !== 0) return r;
    return (b.launchedAt ?? '').localeCompare(a.launchedAt ?? '');
  });
}

/** Running sessions on one install of one daemon. */
export function runningOnInstall(
  sessions: readonly TerminalSessionDto[],
  daemonId: number,
  installId: string,
): number {
  return sessions.filter(
    (s) =>
      s.daemonId === daemonId &&
      s.installId === installId &&
      isLiveSession(s) &&
      s.status === 'Running',
  ).length;
}

export interface AttentionItem {
  tone: 'warn' | 'bad';
  text: string;
}

export interface FleetSummary {
  daemonsOnline: number;
  daemonsTotal: number;
  running: number;
  inFlight: number;
  crashed: number;
  closed: number;
  attention: AttentionItem[];
}

/** The headline numbers and the things that need a look, from the rows already loaded. */
export function fleetSummary(
  daemons: readonly TerminalDaemonDto[],
  sessions: readonly TerminalSessionDto[],
): FleetSummary {
  const attention: AttentionItem[] = [];
  for (const d of daemons) {
    if (!d.isOnline) {
      attention.push({
        tone: 'bad',
        text: `${d.name} is offline — its terminals cannot be launched or closed from here.`,
      });
    }
    if (d.supervisor?.updateState === 'failed') {
      attention.push({
        tone: 'warn',
        text: `${d.name}: the supervisor update did not finish (see its logs).`,
      });
    }
  }
  let running = 0;
  let inFlight = 0;
  let crashed = 0;
  let closed = 0;
  for (const s of sessions) {
    if (s.status === 'Crashed') {
      crashed++;
      attention.push({
        tone: 'bad',
        text: `Session ${s.id} (${s.installId} on ${s.daemonName}) crashed${s.reason ? `: ${s.reason}` : '.'}`,
      });
    } else if (s.status === 'Starting' || s.status === 'Stopping') {
      inFlight++;
    } else if (isLiveSession(s) && s.status === 'Running') {
      running++;
    } else {
      closed++;
    }
  }
  return {
    daemonsOnline: daemons.filter((d) => d.isOnline).length,
    daemonsTotal: daemons.length,
    running,
    inFlight,
    crashed,
    closed,
    attention,
  };
}

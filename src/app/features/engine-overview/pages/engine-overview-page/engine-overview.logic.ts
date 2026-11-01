/**
 * Presentation helpers for the Engine Overview page. Pure functions — no Angular, no I/O.
 */

/**
 * A dead-letter event type as people read it: `PositionClosedIntegrationEvent` → "Position closed",
 * `Lascodia.Events.EAHeartbeatEvent` → "EA heartbeat". The raw name stays available as a tooltip.
 */
export function eventTypeLabel(raw: string | null | undefined): string {
  const name = (raw ?? '').trim();
  if (!name) return 'Unknown event';
  // Strip a namespace and any generic arity / nested-type marker.
  const short = name.split('.').pop()!.split('`')[0].split('+').pop()!;
  const core = short.replace(/(Integration)?Event$/, '') || short;
  const words = core
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/);
  return words
    .map((w, i) => {
      if (w.length > 1 && w === w.toUpperCase()) return w; // acronym: EA, DLQ, ML
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase();
    })
    .join(' ');
}

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface AttentionItem {
  text: string;
  tone: Tone;
  /** Which drill-down page answers it. */
  target: 'workers' | 'dlq' | null;
}

export interface AttentionInput {
  /** null = status not loaded yet. */
  running: boolean | null;
  failed: number;
  degraded: number;
  idle: number;
  /** null = the operator cannot see the dead-letter queue. */
  dlqTotal: number | null;
}

/**
 * The headline under the engine status: what, if anything, needs a look — worst first.
 * Idle workers are listed but neutral: a worker waiting for work is not a fault.
 */
export function attentionItems(i: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (i.running === false) out.push({ text: 'Engine is not running', tone: 'bad', target: null });
  if (i.failed > 0)
    out.push({
      text: plural(i.failed, 'failed worker', 'failed workers'),
      tone: 'bad',
      target: 'workers',
    });
  if (i.degraded > 0)
    out.push({
      text: plural(i.degraded, 'degraded worker', 'degraded workers'),
      tone: 'warn',
      target: 'workers',
    });
  if (i.dlqTotal !== null && i.dlqTotal > 0)
    out.push({
      text: plural(i.dlqTotal, 'unresolved dead letter', 'unresolved dead letters'),
      tone: 'warn',
      target: 'dlq',
    });
  if (i.idle > 0)
    out.push({
      text: plural(i.idle, 'idle worker', 'idle workers'),
      tone: 'neutral',
      target: 'workers',
    });
  return out;
}

/** The overall tone of the headline: the worst item, or ok when nothing needs a look. */
export function overallTone(items: readonly AttentionItem[]): Tone {
  if (items.some((x) => x.tone === 'bad')) return 'bad';
  if (items.some((x) => x.tone === 'warn')) return 'warn';
  return 'ok';
}

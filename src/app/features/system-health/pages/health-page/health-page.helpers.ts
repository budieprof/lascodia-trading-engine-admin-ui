/**
 * Pure presentation helpers for the System Health page.
 */

/**
 * Plain-language label for an integration-event class name, e.g.
 * `PositionClosedIntegrationEvent` → `Position closed`. The raw name stays available to the
 * caller (shown as a monospace sub-line / title) — this only makes the headline readable.
 * Unknown shapes are returned unchanged; null/blank becomes `Unknown event`.
 */
export function humanizeEventType(raw: string | null | undefined): string {
  const name = (raw ?? '').trim();
  if (!name) return 'Unknown event';
  // Drop a namespace prefix ("Lascodia.Events.FooEvent") and generic arity ("Foo`1").
  const last = name.split(/[.+]/).pop() ?? name;
  const base = last.replace(/`\d+$/, '').replace(/(IntegrationEvent|Event)$/, '');
  if (!base) return name;
  // Split CamelCase while keeping acronyms together ("VaRBreach" → "VaR breach", "EAHeartbeat" → "EA heartbeat").
  // "VaR" is the one mixed-case term the engine uses; split around it, not through it.
  const words = base
    .replace(/VaR(?=[A-Z]|$)/g, ' VaR ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/ Va R /g, ' VaR ')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return name;
  return words
    .map((w, i) => {
      // Keep acronyms / mixed-case tokens ("EA", "VaR", "ML") as written.
      const isAcronym = w.length > 1 && w !== w[0] + w.slice(1).toLowerCase();
      if (isAcronym) return w;
      return i === 0 ? w : w.toLowerCase();
    })
    .join(' ');
}

export type IdleReasonKind = 'off' | 'on' | 'unknown';

export interface IdleReason {
  kind: IdleReasonKind;
  /** The Engine Config key that switches the worker. */
  key: string;
  /** yyyy-mm-dd the switch row was last changed, when known. */
  since: string | null;
}

/**
 * Why an idle worker (no error, no completed cycle) is idle, from its `Workers:{name}:Enabled`
 * row. `undefined` = the row has not been read yet; `null` = no row (the worker's default: on).
 */
export function idleReasonOf(
  name: string,
  sw: { value: string; at: string } | null | undefined,
): IdleReason {
  const key = `Workers:${name}:Enabled`;
  if (sw === undefined) return { kind: 'unknown', key, since: null };
  if (sw && sw.value.trim().toLowerCase() === 'false') {
    const since = (sw.at ?? '').slice(0, 10);
    return { kind: 'off', key, since: since || null };
  }
  return { kind: 'on', key, since: null };
}

/** Duration in the largest readable unit: "166 ms", "12.3 s", "6.6 min", "1.4 h". */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(ms)} ms`;
  if (a < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (a < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

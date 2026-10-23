import type {
  PublicStatusComponent,
  PublicStatusDocument,
  PublicStatusLevel,
} from './status.types';

/** What the page shows when the engine cannot be reached at all. */
export type PageView =
  | { kind: 'loading' }
  | { kind: 'unreachable'; lastGood: PublicStatusDocument | null }
  | { kind: 'ready'; doc: PublicStatusDocument };

export type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const KNOWN: readonly PublicStatusLevel[] = ['operational', 'degraded', 'outage', 'idle'];

/** A level the page understands; anything else the engine might send later reads as degraded, never as fine. */
export function normaliseLevel(value: unknown): PublicStatusLevel {
  return typeof value === 'string' && (KNOWN as readonly string[]).includes(value)
    ? (value as PublicStatusLevel)
    : 'degraded';
}

export function levelLabel(level: PublicStatusLevel): string {
  switch (level) {
    case 'operational':
      return 'Operational';
    case 'degraded':
      return 'Degraded';
    case 'outage':
      return 'Outage';
    case 'idle':
      return 'Markets closed';
  }
}

export function levelTone(level: PublicStatusLevel): Tone {
  switch (level) {
    case 'operational':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'outage':
      return 'danger';
    case 'idle':
      return 'neutral';
  }
}

/** The banner headline: the engine's own sentence, or one of ours when it cannot be reached. */
export function headline(view: PageView): { text: string; tone: Tone } {
  switch (view.kind) {
    case 'loading':
      return { text: 'Checking status…', tone: 'neutral' };
    case 'unreachable':
      return { text: 'The status service cannot be reached.', tone: 'danger' };
    case 'ready':
      return { text: view.doc.message, tone: levelTone(normaliseLevel(view.doc.status)) };
  }
}

/** Display order: problems first, then the rest in the engine's order. */
export function orderComponents(
  components: readonly PublicStatusComponent[],
): PublicStatusComponent[] {
  const rank = (c: PublicStatusComponent) => {
    switch (normaliseLevel(c.status)) {
      case 'outage':
        return 0;
      case 'degraded':
        return 1;
      default:
        return 2;
    }
  };
  return components
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => ({ ...c, status: normaliseLevel(c.status) }));
}

/** "Updated 12 s ago" / "Updated 3 min ago" — from the engine's own timestamp. */
export function updatedText(generatedAtUtc: string | null | undefined, nowMs: number): string {
  if (!generatedAtUtc) return '';
  const at = Date.parse(generatedAtUtc);
  if (Number.isNaN(at)) return '';
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) return `Updated ${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Updated ${minutes} min ago`;
  return `Updated ${Math.round(minutes / 60)} h ago`;
}

/** Shape check of the engine's answer: a malformed document is treated as unreachable, never rendered half. */
export function parseDocument(body: unknown): PublicStatusDocument | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b['message'] !== 'string' || !Array.isArray(b['components'])) return null;
  const components = (b['components'] as unknown[])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .filter((c) => typeof c['id'] === 'string' && typeof c['name'] === 'string')
    .map((c) => ({
      id: c['id'] as string,
      name: c['name'] as string,
      status: normaliseLevel(c['status']),
      message: typeof c['message'] === 'string' ? (c['message'] as string) : '',
    }));
  const overall = normaliseLevel(b['status']);
  return {
    status: overall === 'idle' ? 'operational' : overall,
    message: b['message'] as string,
    generatedAtUtc: typeof b['generatedAtUtc'] === 'string' ? (b['generatedAtUtc'] as string) : '',
    components,
  };
}

/** Poll interval: the engine caches 10 s; a public page needs no more than every 30 s. */
export const STATUS_POLL_MS = 30_000;

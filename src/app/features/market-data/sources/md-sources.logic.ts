import type { MarketDataSourceAdmin, UpdateMarketDataSourceBody } from './md-sources.types';

/** The engine's writer id rule (machine instance ids). */
const WRITER = /^[A-Za-z0-9._:-]{1,128}$/;
/** Engine symbols. */
const SYMBOL = /^[A-Z0-9._]{1,10}$/;
/** A venue's id (lowercase slug). */
const VENUE = /^[a-z0-9](?:[a-z0-9._-]{0,46}[a-z0-9])?$/;

/** Writer ids typed one per line or comma-separated → a clean, sorted, distinct list. */
export function parseWriters(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ].sort();
}

/** The writers the engine would refuse. */
export function badWriters(writers: string[]): string[] {
  return writers.filter((w) => !WRITER.test(w));
}

/** `EURUSD=6E, USDJPY=6J` (or one per line) → `{ EURUSD: '6E', USDJPY: '6J' }`; problems listed. */
export function parseSymbolMap(text: string): { map: Record<string, string>; problems: string[] } {
  const map: Record<string, string> = {};
  const problems: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const key = (eq < 0 ? entry : entry.slice(0, eq)).trim().toUpperCase();
    const value = eq < 0 ? '' : entry.slice(eq + 1).trim();
    if (!SYMBOL.test(key) || !value || value.length > 64) problems.push(entry);
    else map[key] = value;
  }
  return { map, problems };
}

/** The map as the editor shows it: `EURUSD=6E` per line, sorted. */
export function formatSymbolMap(map: Record<string, string> | null | undefined): string {
  return Object.entries(map ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function isVenueId(id: string): boolean {
  return VENUE.test(id);
}

/** MT5 broker rows belong to the engine (it creates them as EAs stream); staff edit external sources only. */
export function isEditable(s: Pick<MarketDataSourceAdmin, 'kind'>): boolean {
  return s.kind !== 'Mt5Broker';
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case 'Mt5Broker':
      return 'MT5 broker';
    case 'CmeFutures':
      return 'CME futures';
    case 'FixVenue':
      return 'FX venue (FIX)';
    default:
      return kind;
  }
}

/** One line on why a source is (not) delivering, from what the registry knows. */
export function readiness(s: MarketDataSourceAdmin): {
  text: string;
  tone: 'ok' | 'info' | 'warn';
} {
  if (s.kind === 'Mt5Broker')
    return s.enabled
      ? { text: 'Streams from trusted EAs', tone: 'ok' }
      : { text: 'Disabled', tone: 'warn' };
  if (!s.enabled) return { text: 'Disabled — nothing is stored', tone: 'info' };
  if (s.writerInstanceIds.length === 0)
    return { text: 'Enabled but no writer: every post is refused', tone: 'warn' };
  return { text: 'Enabled', tone: 'ok' };
}

/** What a save sends: only the fields that differ from the row (the engine refuses "nothing to change"). */
export function changes(
  row: MarketDataSourceAdmin,
  edit: {
    enabled: boolean;
    displayName: string;
    writers: string[];
    symbolMap: Record<string, string>;
    contractSize: number;
  },
): UpdateMarketDataSourceBody {
  const body: UpdateMarketDataSourceBody = {};
  if (edit.enabled !== row.enabled) body.enabled = edit.enabled;
  if (edit.displayName.trim() && edit.displayName.trim() !== row.displayName)
    body.displayName = edit.displayName.trim();
  if (JSON.stringify(edit.writers) !== JSON.stringify([...row.writerInstanceIds].sort()))
    body.writerInstanceIds = edit.writers;
  if (formatSymbolMap(edit.symbolMap) !== formatSymbolMap(row.symbolMap))
    body.symbolMap = edit.symbolMap;
  if (Number.isFinite(edit.contractSize) && edit.contractSize !== row.contractSize)
    body.contractSize = edit.contractSize;
  return body;
}

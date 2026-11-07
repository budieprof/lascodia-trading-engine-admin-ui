import type { ChartBarsResult } from '@core/api/scripting.types';
import type { SessionClosure } from './session-calendar';

/**
 * What a symbol's bars ARE, as `scripting/chart-bars` says with them (multi-asset chart program contract C1): the asset
 * class, the trading calendar, what the volume counts, which candle source they were read from, the calendar's closures
 * and the corporate-action adjustment applied. Pure; the feed keeps the newest answer per symbol.
 *
 * Every field is optional on the wire (an engine before C1 sends none): absent stays null, and every label built on it
 * says "unknown" rather than assume FX.
 */

/** A candle source (C1 `source`, C2 `candleSource`). */
export interface ChartSource {
  id: string;
  kind: 'mt5' | 'venue' | string;
  label: string;
}

export type VolumeKind = 'tick' | 'base' | 'contracts' | 'shares';

export interface SymbolFacts {
  assetClass: string | null;
  calendarCode: string | null;
  volumeKind: VolumeKind | null;
  source: ChartSource | null;
  adjustment: string | null;
}

const VOLUME_KINDS: readonly string[] = ['tick', 'base', 'contracts', 'shares'];

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The C1 facts of one chart-bars answer; null when it carries none of them (an engine before C1). */
export function readChartFacts(
  res: Partial<ChartBarsResult> | null | undefined,
): SymbolFacts | null {
  if (!res) return null;
  const has =
    'assetClass' in res || 'volumeKind' in res || 'source' in res || 'calendarCode' in res;
  if (!has) return null;
  const src = res.source;
  const source =
    src && text(src.id)
      ? {
          id: text(src.id)!,
          kind: text(src.kind) ?? 'venue',
          label: text(src.label) ?? text(src.id)!,
        }
      : null;
  const vk = text(res.volumeKind);
  return {
    assetClass: text(res.assetClass),
    calendarCode: text(res.calendarCode),
    volumeKind: vk && VOLUME_KINDS.includes(vk) ? (vk as VolumeKind) : null,
    source,
    adjustment: text(res.adjustment),
  };
}

/** C1 `closures`, kept only when well formed. */
export function readClosures(res: Partial<ChartBarsResult> | null | undefined): SessionClosure[] {
  const raw = Array.isArray(res?.closures) ? res!.closures : [];
  return raw
    .filter(
      (c) =>
        !!c &&
        Number.isFinite(c.fromMs) &&
        Number.isFinite(c.toMs) &&
        (c.toMs as number) > (c.fromMs as number),
    )
    .map((c) => ({
      fromMs: c.fromMs,
      toMs: c.toMs,
      kind: text(c.kind) ?? 'Holiday',
      label: text(c.label) ?? '',
    }));
}

/** At most this many closures are remembered per symbol (a long scroll-back of a 1h chart reports a break a day). */
export const MAX_CLOSURES = 600;

/** `held` with `incoming` added (same span and kind = the same closure), ascending, the newest {@link MAX_CLOSURES}. */
export function mergeClosures(
  held: readonly SessionClosure[],
  incoming: readonly SessionClosure[],
): SessionClosure[] {
  if (!incoming.length) return held.slice();
  const byKey = new Map<string, SessionClosure>();
  for (const c of [...held, ...incoming]) byKey.set(`${c.fromMs}|${c.toMs}|${c.kind}`, c);
  const out = [...byKey.values()].sort((a, b) => a.fromMs - b.fromMs);
  return out.length > MAX_CLOSURES ? out.slice(out.length - MAX_CLOSURES) : out;
}

/** The C1 oldest-bar instant, or null. */
export function readFirstBarMs(res: Partial<ChartBarsResult> | null | undefined): number | null {
  const v = res?.firstBarMs;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Whether a source is a venue (exchange) feed rather than the MT5 broker's — null source: not known to be one. */
export function isVenueSource(source: ChartSource | null | undefined): boolean {
  return !!source && source.kind !== 'mt5' && source.id !== 'mt5';
}

/** What the volume counts, as a legend label: "tick volume", "volume (BTC)", "contracts", "shares", "volume unknown". */
export function volumeLabel(
  kind: VolumeKind | null | undefined,
  baseAsset?: string | null,
): string {
  switch (kind) {
    case 'tick':
      return 'tick volume';
    case 'base':
      return baseAsset ? `volume (${baseAsset})` : 'volume (base asset)';
    case 'contracts':
      return 'volume (contracts)';
    case 'shares':
      return 'volume (shares)';
    default:
      return 'volume (unit unknown)';
  }
}

/** The short tag the legend puts after "Vol": `ticks`, `BTC`, `contracts`, `shares`; null when unknown. */
export function volumeUnitTag(
  kind: VolumeKind | null | undefined,
  baseAsset?: string | null,
): string | null {
  switch (kind) {
    case 'tick':
      return 'ticks';
    case 'base':
      return baseAsset || 'base';
    case 'contracts':
      return 'contracts';
    case 'shares':
      return 'shares';
    default:
      return null;
  }
}

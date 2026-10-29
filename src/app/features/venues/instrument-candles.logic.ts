import type {
  FeatureRequirement,
  FeatureStateKind,
} from '@shared/components/feedback/feature-state.component';

import type {
  FuturesCatalogRoot,
  InstrumentCandleReadiness,
  InstrumentCandleState,
} from './venues.types';

/** A summary tile: real figure + one line on what it means. */
export interface CandleTile {
  label: string;
  value: string;
  hint: string;
  tone?: 'ok' | 'warn' | 'bad' | null;
}

export interface RollRow {
  root: string;
  exchange: string;
  group: string;
  description: string;
  continuousSymbol: string;
  rollRule: string;
  /** In the instrument master (FutureRoot row): the builder stitches its continuous series. */
  inMaster: boolean;
  next: { contract: string; rollUtc: string; days: number } | null;
  following: { contract: string; rollUtc: string } | null;
  lastRolled: { contract: string; rollUtc: string } | null;
  continuousStatus: string | null;
}

const DAY_MS = 86_400_000;
/** The worker runs every PollIntervalSeconds (60 s by default); a success older than this is "not running". */
const WORKER_FRESH_MS = 15 * 60_000;

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function daysUntil(iso: string, nowMs: number): number {
  return Math.ceil((Date.parse(iso) - nowMs) / DAY_MS);
}

export function eligibleTotal(r: InstrumentCandleReadiness | null): number | null {
  if (!r) return null;
  return Object.values(r.eligibleByClass ?? {}).reduce((a, b) => a + b, 0);
}

/** Non-MT5 sources that are enabled and have a writer (the only ones that can store trades). */
export function writableSources(r: InstrumentCandleReadiness) {
  return r.sources.filter((s) => s.enabled && s.writers > 0);
}

/** Sources whose latest stored day is today (UTC) — receiving now. */
export function receivingSources(r: InstrumentCandleReadiness, nowMs: number) {
  const today = utcDay(nowMs);
  return r.sources.filter((s) => s.lastStoredDay === today);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The builder's chain, link by link, each from engine data: switch → worker cycling → a source enabled with a writer
 * → trades stored → stored today → symbols claimed. `readiness` null = the engine has no readiness endpoint yet; the
 * links it alone knows are then "unknown" (null), never guessed.
 */
export function candleChain(
  state: InstrumentCandleState,
  r: InstrumentCandleReadiness | null,
  nowMs: number,
): { kind: FeatureStateKind; detail: string; requirements: FeatureRequirement[] } {
  const reqs: FeatureRequirement[] = [];
  const on = r?.builderEnabled ?? state.builderEnabled;
  reqs.push({
    label: 'Builder switched on',
    ok: on,
    detail: on
      ? 'MarketData:InstrumentCandles:Enabled = true'
      : 'MarketData:InstrumentCandles:Enabled = false — nothing is read or written',
    route: '/engine-config',
    query: { search: 'MarketData:InstrumentCandles' },
  });

  if (r) {
    const last = r.workerLastSuccessUtc ? Date.parse(r.workerLastSuccessUtc) : null;
    const fresh = last !== null && nowMs - last < WORKER_FRESH_MS;
    reqs.push({
      label: 'Builder worker cycling',
      ok: last === null ? null : fresh && !(r.workerConsecutiveFailures ?? 0),
      detail:
        last === null
          ? 'No health snapshot of InstrumentCandleWorker yet (it runs in the research process).'
          : `Last successful cycle ${Math.max(0, Math.round((nowMs - last) / 60_000))} min ago, every ${r.pollIntervalSeconds} s` +
            (r.workerLastError ? ` · last error: ${r.workerLastError}` : ''),
      route: '/worker-health',
    });
    const writable = writableSources(r);
    reqs.push({
      label: 'A futures, crypto or stock source enabled with a writer',
      ok: writable.length > 0,
      detail: writable.length
        ? `${writable.map((s) => s.sourceId).join(', ')} (${plural(r.sources.length, 'non-MT5 source')} registered)`
        : `${plural(r.sources.length, 'non-MT5 source')} registered, none enabled with a writer machine id`,
      route: '/market-data/sources',
    });
    const storing = r.sources.filter((s) => s.storedEligible > 0);
    reqs.push({
      label: 'Trades stored for an eligible instrument',
      ok: storing.length > 0,
      detail: storing.length
        ? storing.map((s) => `${s.sourceId}: ${plural(s.storedEligible, 'symbol')}`).join(' · ')
        : writable.length
          ? 'Sources are enabled but the store holds no trades from them yet — is the feed process (crypto / venues / equities profile) running?'
          : 'The store holds no futures, crypto or stock trades.',
      route: '/market-data/sources',
    });
    const live = receivingSources(r, nowMs);
    reqs.push({
      label: 'Receiving today',
      ok: storing.length === 0 ? null : live.length > 0,
      detail: live.length
        ? `${live.map((s) => s.sourceId).join(', ')} stored data today (UTC)`
        : storing.length
          ? `Newest stored day: ${storing
              .map((s) => s.lastStoredDay)
              .sort()
              .at(-1)}`
          : 'Nothing stored yet.',
    });
  } else {
    reqs.push({
      label: 'Sources and stored trades',
      ok: null,
      detail:
        'Needs the engine update that adds instrument-candles/readiness — see the sources page meanwhile.',
      route: '/market-data/sources',
    });
  }

  const cursors = state.cursors.filter((c) => c.kind === 'Instrument').length;
  reqs.push({
    label: 'Symbols claimed by the builder',
    ok: cursors > 0 ? true : on ? false : null,
    detail: cursors
      ? `${plural(cursors, 'symbol')} with a cursor (${Object.entries(state.statusCounts)
          .map(([k, v]) => `${v} ${k}`)
          .join(', ')})`
      : 'A symbol is claimed on the first cycle after its trades are stored.',
  });

  let kind: FeatureStateKind;
  let detail: string;
  if (!on) {
    kind = 'off';
    detail = 'Switched off: no futures, crypto or stock candle is written.';
  } else if (cursors > 0) {
    kind = 'on';
    detail = `Building ${plural(cursors, 'symbol')}.`;
  } else if (r && writableSources(r).length === 0) {
    kind = 'partial';
    detail = 'On, but no futures, crypto or stock data source is enabled — nothing feeds it.';
  } else {
    kind = 'waiting';
    detail = 'On and waiting for the first stored exchange trade print.';
  }
  return { kind, detail, requirements: reqs };
}

export function candleTiles(
  state: InstrumentCandleState,
  r: InstrumentCandleReadiness | null,
  rolls: RollRow[],
  nowMs: number,
): CandleTile[] {
  const tiles: CandleTile[] = [];
  const total = eligibleTotal(r);
  tiles.push({
    label: 'Symbols eligible',
    value: total === null ? '—' : total.toLocaleString('en-US'),
    hint:
      r === null
        ? 'needs the engine update'
        : Object.entries(r.eligibleByClass)
            .map(([k, v]) => `${v.toLocaleString('en-US')} ${k.toLowerCase()}`)
            .join(' · ') || 'no futures / crypto / stock in the instrument master',
  });
  if (r) {
    const live = receivingSources(r, nowMs).length;
    tiles.push({
      label: 'Sources live',
      value: `${live} / ${writableSources(r).length}`,
      hint: `storing today / enabled with a writer (of ${r.sources.length} registered)`,
      tone: live > 0 ? 'ok' : writableSources(r).length ? 'warn' : null,
    });
  }
  const live = state.cursors.filter((c) => c.status === 'Live').length;
  tiles.push({
    label: 'Symbols built',
    value: String(state.cursors.length),
    hint: state.cursors.length ? `${live} live` : 'none claimed yet',
    tone: state.cursors.length ? 'ok' : null,
  });
  if (r) {
    tiles.push({
      label: 'Bars built, 24 h',
      value: r.barsLast24h.toLocaleString('en-US'),
      hint: 'one-minute bars (M1) in the last 24 hours',
    });
  } else {
    const written = state.cursors.reduce((a, c) => a + (c.barsWritten ?? 0), 0);
    tiles.push({
      label: 'Candle rows written',
      value: written.toLocaleString('en-US'),
      hint: 'all timeframes, since each symbol was claimed',
    });
  }
  const lags = state.cursors
    .map((c) => c.lagMinutes)
    .filter((m): m is number => typeof m === 'number');
  tiles.push({
    label: 'Worst lag',
    value: lags.length ? lagLabel(Math.max(...lags)) : '—',
    hint: lags.length ? 'built end vs now, slowest symbol' : 'no symbol built yet',
    tone: lags.length && Math.max(...lags) > 30 ? 'warn' : null,
  });
  const next = rolls
    .filter((x) => x.next)
    .sort((a, b) => Date.parse(a.next!.rollUtc) - Date.parse(b.next!.rollUtc))[0];
  tiles.push({
    label: 'Next futures roll',
    value: next?.next ? `${next.next.days} d` : '—',
    hint: next?.next
      ? `${next.root}: ${next.next.contract} on ${next.next.rollUtc.slice(0, 10)}`
      : 'no roll scheduled',
  });
  return tiles;
}

export function lagLabel(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

/**
 * The roll calendar: one row per futures root. Master roots (stitched by the builder) come from readiness with their
 * recorded contract dates; every other root the futures catalog knows comes from the catalog's nearby contracts.
 */
export function rollRows(
  r: InstrumentCandleReadiness | null,
  catalog: FuturesCatalogRoot[],
  nowMs: number,
): RollRow[] {
  const rows = new Map<string, RollRow>();
  for (const c of catalog) {
    const upcoming = (c.nearby ?? [])
      .filter((n) => Date.parse(n.rollUtc) > nowMs)
      .sort((a, b) => Date.parse(a.rollUtc) - Date.parse(b.rollUtc));
    rows.set(c.root, {
      root: c.root,
      exchange: c.exchange,
      group: c.group,
      description: c.description,
      continuousSymbol: c.continuousSymbol,
      rollRule: c.rollRule,
      inMaster: false,
      next: upcoming[0]
        ? {
            contract: upcoming[0].contract,
            rollUtc: upcoming[0].rollUtc,
            days: daysUntil(upcoming[0].rollUtc, nowMs),
          }
        : null,
      following: upcoming[1]
        ? { contract: upcoming[1].contract, rollUtc: upcoming[1].rollUtc }
        : null,
      lastRolled: null,
      continuousStatus: null,
    });
  }
  for (const m of r?.roots ?? []) {
    const base = rows.get(m.root);
    const [n, f] = m.upcoming;
    rows.set(m.root, {
      root: m.root,
      exchange: m.exchange,
      group: base?.group ?? '',
      description: m.description ?? base?.description ?? '',
      continuousSymbol: m.continuousSymbol,
      rollRule: m.rollRule,
      inMaster: true,
      next: n
        ? { contract: n.contract, rollUtc: n.rollUtc, days: daysUntil(n.rollUtc, nowMs) }
        : (base?.next ?? null),
      following: f ? { contract: f.contract, rollUtc: f.rollUtc } : (base?.following ?? null),
      lastRolled: m.lastRolled
        ? { contract: m.lastRolled.contract, rollUtc: m.lastRolled.rollUtc }
        : null,
      continuousStatus: m.continuousStatus,
    });
  }
  return [...rows.values()].sort(
    (a, b) =>
      Number(b.inMaster) - Number(a.inMaster) ||
      (a.next ? Date.parse(a.next.rollUtc) : Infinity) -
        (b.next ? Date.parse(b.next.rollUtc) : Infinity) ||
      a.root.localeCompare(b.root),
  );
}

export const ADJUSTMENTS: { method: string; title: string; text: string }[] = [
  {
    method: 'Panama',
    title: 'Panama (add the gap)',
    text: 'At each roll the price gap between the old and new contract is added to every earlier bar, so the series has no jump. Price levels of old bars move; point moves are kept. The engine’s CME convention.',
  },
  {
    method: 'Ratio',
    title: 'Ratio (multiply)',
    text: 'Earlier bars are multiplied by new ÷ old price at each roll. Percentage returns are kept and prices never go negative; point moves change.',
  },
  {
    method: 'None',
    title: 'None (raw stitch)',
    text: 'Contracts are joined as traded, so each roll shows as a jump. The unadjusted series (ES1!U) is always built this way.',
  },
];

/**
 * News Intelligence cockpit — pure decisions behind the multi-asset pages (news-intel program,
 * 2026-11-07). No Angular, no I/O: every rule here is pinned by `news-intel.logic.spec.ts`.
 *
 * The engine is the authority on every number. These helpers only reshape what it returned, and
 * where the engine does not say something (which calendar keys are legacy-enforced, how many entries
 * the multi-asset blackout would have refused) they say "not reported" rather than guess.
 */
import {
  ExposureKindName,
  NewsConfigEntry,
  NewsEvalRunView,
  NewsExposureLegView,
  NewsFeedStateView,
  NewsFocusResult,
  NewsSourceLatencyView,
  NewsStoryView,
  ScheduledMarketEventRow,
  SECRET_SET,
  SECRET_UNSET,
} from './news-intel.types';

// ── Exposure keys ────────────────────────────────────────────────────────

const COMMODITIES = new Set(['XAU', 'XAG', 'XPT', 'XPD', 'WTI', 'BRENT', 'NATGAS']);

/** Kind of an exposure key from its grammar (mirror of engine `ExposureKey.KindOf`); null when malformed. */
export function exposureKindOf(key: string | null | undefined): ExposureKindName | null {
  const k = (key ?? '').trim().toUpperCase();
  if (!k || k.length > 32) return null;
  const prefixed: [string, ExposureKindName][] = [
    ['IDX:', 'EquityIndex'],
    ['EQ:', 'Equity'],
    ['CR:', 'Crypto'],
    ['F:', 'Factor'],
  ];
  for (const [prefix, kind] of prefixed) {
    if (k.startsWith(prefix)) return k.length > prefix.length ? kind : null;
  }
  if (COMMODITIES.has(k)) return 'Commodity';
  if (/^[A-Z]{3}$/.test(k)) return 'Currency';
  return null;
}

/** Display names for exposure kinds. */
export const EXPOSURE_KIND_LABEL: Record<ExposureKindName, string> = {
  Currency: 'Currency',
  Commodity: 'Commodity',
  EquityIndex: 'Index',
  Equity: 'Stock',
  Crypto: 'Crypto',
  Factor: 'Factor',
};

/** Parses a comma/whitespace-separated exposure list the way the engine does: valid keys, upper-cased, de-duplicated, in order. */
export function parseExposureList(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(/[,\s]+/)) {
    const k = part.trim().toUpperCase();
    if (k && exposureKindOf(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

/** Entries of a comma list that the engine would drop as malformed (shown to the operator, never silently lost). */
export function invalidExposureTokens(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t && !exposureKindOf(t));
}

// ── Asset class of a symbol ──────────────────────────────────────────────

export type SymbolAssetClass = 'FX' | 'Metal' | 'Energy' | 'Index' | 'Stock' | 'Crypto' | 'Unplaced';

export const ASSET_CLASSES: readonly SymbolAssetClass[] = [
  'FX',
  'Metal',
  'Energy',
  'Index',
  'Stock',
  'Crypto',
  'Unplaced',
];

const METALS = new Set(['XAU', 'XAG', 'XPT', 'XPD']);

/**
 * Asset class from the symbol's exposure legs: the leg the symbol IS (weight +1, basis own/base).
 * Pure presentation — the engine's own classification decides nothing here.
 */
export function assetClassOf(legs: readonly { key: string; weight: number; basis: string }[]): SymbolAssetClass {
  if (!legs.length) return 'Unplaced';
  const primary =
    legs.find((l) => l.basis === 'own') ??
    legs.find((l) => l.basis === 'base') ??
    legs.reduce((a, b) => (Math.abs(b.weight) > Math.abs(a.weight) ? b : a));
  const key = primary.key.toUpperCase();
  switch (exposureKindOf(key)) {
    case 'Equity':
      return 'Stock';
    case 'EquityIndex':
      return 'Index';
    case 'Crypto':
      return 'Crypto';
    case 'Commodity':
      return METALS.has(key) ? 'Metal' : 'Energy';
    case 'Currency':
      return 'FX';
    default:
      return 'Unplaced';
  }
}

// ── Coverage ─────────────────────────────────────────────────────────────

/** One leg on the coverage page: static or fitted weight, tracked or not. */
export interface CoverageLeg {
  key: string;
  kind: ExposureKindName | null;
  weight: number;
  basis: string;
  fitted: boolean;
  covered: boolean;
  score: number | null;
  /** Minutes since the newest weighted item on this key; null when unknown. */
  newestAgeMinutes: number | null;
}

/** One symbol's row on the coverage page. */
export interface CoverageRow {
  symbol: string;
  assetClass: SymbolAssetClass;
  legs: CoverageLeg[];
  coveredLegs: number;
  untrackedLegs: number;
  /** Share of Σ|weight| on tracked legs, 0..1 — the engine's figure when it gave one. */
  coverage: number | null;
  /** tanh(Σ weight × score); null when coverage would mislead (engine rule). */
  symbolBias: number | null;
  /** Minutes since the newest weighted item across all legs; null when unknown. */
  newestAgeMinutes: number | null;
  calendarKeys: string[];
  /** Calendar keys that are not plain currencies — the ones the multi-asset mode governs for this symbol. */
  modeGovernedKeys: string[];
  /** catalogue | instrument | fitted | unresolved. */
  source: string;
  includedInPrompt: boolean;
  omissionReason: string | null;
  /** Why the row has no exposure data (focus failed / symbol unplaced). */
  problem: string | null;
}

/**
 * Builds a coverage row from the engine's focus answer. `trackedKeys` decides "covered" only when the
 * engine did not say (an engine without `legs`); `newestAge` maps a key to the age of its newest item.
 */
export function coverageRowFrom(
  symbol: string,
  focus: NewsFocusResult | null,
  trackedKeys: ReadonlySet<string>,
  newestAge: ReadonlyMap<string, number> = new Map(),
  problem: string | null = null,
): CoverageRow {
  const exposure = focus?.exposure ?? null;
  const ctxLegs: NewsExposureLegView[] = focus?.context?.legs ?? [];
  const byKey = new Map(ctxLegs.map((l) => [l.key.toUpperCase(), l]));

  const source = exposure?.source ?? (focus ? 'unresolved' : 'unresolved');
  const rawLegs = exposure?.legs?.length
    ? exposure.legs
    : ctxLegs.map((l) => ({ key: l.key, weight: l.weight, basis: l.basis }));

  const legs: CoverageLeg[] = rawLegs.map((l) => {
    const key = l.key.toUpperCase();
    const reading = byKey.get(key);
    const covered = reading ? reading.covered : trackedKeys.has(key);
    return {
      key,
      kind: exposureKindOf(key),
      weight: l.weight,
      basis: l.basis,
      fitted: l.basis === 'factor:fitted',
      covered,
      score: reading?.score ?? null,
      newestAgeMinutes: covered ? (newestAge.get(key) ?? null) : null,
    };
  });

  const total = legs.reduce((s, l) => s + Math.abs(l.weight), 0);
  const coveredWeight = legs.filter((l) => l.covered).reduce((s, l) => s + Math.abs(l.weight), 0);
  const engineCoverage = focus?.context?.coverage;
  const coverage =
    engineCoverage !== undefined && engineCoverage !== null
      ? engineCoverage
      : total > 0
        ? coveredWeight / total
        : null;

  const ages = legs.map((l) => l.newestAgeMinutes).filter((a): a is number => a !== null);
  const calendarKeys = (exposure?.calendarKeys ?? []).map((k) => k.toUpperCase());

  return {
    symbol,
    assetClass: assetClassOf(rawLegs),
    legs,
    coveredLegs: legs.filter((l) => l.covered).length,
    untrackedLegs: legs.filter((l) => !l.covered).length,
    coverage,
    symbolBias: focus?.context?.symbolBias ?? focus?.context?.pairBias ?? null,
    newestAgeMinutes: ages.length ? Math.min(...ages) : null,
    calendarKeys,
    modeGovernedKeys: calendarKeys.filter((k) => exposureKindOf(k) !== 'Currency'),
    source,
    includedInPrompt: focus?.includedInPrompt ?? false,
    omissionReason: focus?.omissionReason ?? null,
    problem: problem ?? (focus && !rawLegs.length ? 'The exposure map cannot place this symbol.' : null),
  };
}

/** Summary tiles for the coverage page. */
export function coverageSummary(rows: readonly CoverageRow[]): {
  symbols: number;
  fullyCovered: number;
  partlyCovered: number;
  uncovered: number;
  unplaced: number;
  withModeGovernedKeys: number;
} {
  let fully = 0;
  let partly = 0;
  let none = 0;
  let unplaced = 0;
  let governed = 0;
  for (const r of rows) {
    if (!r.legs.length) unplaced++;
    else if (r.untrackedLegs === 0) fully++;
    else if (r.coveredLegs === 0) none++;
    else partly++;
    if (r.modeGovernedKeys.length) governed++;
  }
  return {
    symbols: rows.length,
    fullyCovered: fully,
    partlyCovered: partly,
    uncovered: none,
    unplaced,
    withModeGovernedKeys: governed,
  };
}

/** Every key that some row's legs need but the module does not track, with how many symbols need it. */
export function untrackedDemand(rows: readonly CoverageRow[]): { key: string; symbols: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const l of r.legs) if (!l.covered) counts.set(l.key, (counts.get(l.key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, symbols]) => ({ key, symbols }))
    .sort((a, b) => b.symbols - a.symbols || a.key.localeCompare(b.key));
}

/**
 * Newest weighted item per exposure key from a `/pressure` answer (min age over its contributors).
 * Contributors are sorted by weight, not time, so this is "newest item that still carries weight".
 */
export function newestAgeByKey(
  readings: readonly { currency: string; topContributors?: { ageMinutes: number }[] | null }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of readings) {
    const ages = (r.topContributors ?? []).map((c) => c.ageMinutes).filter((a) => Number.isFinite(a));
    if (ages.length) out.set(r.currency.toUpperCase(), Math.round(Math.min(...ages)));
  }
  return out;
}

// ── Multi-asset blackout mode (`NewsBlackout:MultiAsset:Mode`) ───────────

export type MultiAssetMode = 'Off' | 'Observe' | 'Enforce';
export const MULTI_ASSET_MODE_KEY = 'NewsBlackout:MultiAsset:Mode';
export const MULTI_ASSET_MODES: readonly MultiAssetMode[] = ['Off', 'Observe', 'Enforce'];

/**
 * The mode as the engine reads it: case-insensitive; unknown or missing = Observe (the shipped
 * default). Only Enforce refuses entries on the keys the exposure map added.
 */
export function parseMultiAssetMode(raw: string | null | undefined): MultiAssetMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'enforce') return 'Enforce';
  if (v === 'off') return 'Off';
  return 'Observe';
}

/** One sentence saying what a mode does to a symbol whose calendar adds non-currency keys. */
export function blackoutModeText(mode: MultiAssetMode, governedKeys: readonly string[]): string {
  if (!governedKeys.length) {
    return 'Currency calendar only — the legacy blackout applies; the multi-asset mode is not read.';
  }
  const keys = governedKeys.join(', ');
  switch (mode) {
    case 'Enforce':
      return `Enforce — High-impact events on ${keys} refuse new entries.`;
    case 'Off':
      return `Off — events on ${keys} are neither blocked nor recorded.`;
    default:
      return `Observe — events on ${keys} are recorded as "would block"; entries still go through.`;
  }
}

// ── Config helpers ───────────────────────────────────────────────────────

const SECRET_SUFFIXES = [
  'Key',
  'Secret',
  'Password',
  'Passphrase',
  'Token',
  'Credential',
  'Credentials',
  'ConnectionString',
  'WebhookUrl',
  'Dsn',
];

/** Mirror of engine `SecretConfigKeys.IsSecret`: the key's last segment ends with a secret suffix. */
export function isSecretKey(key: string): boolean {
  const leaf = key.trim().slice(key.trim().lastIndexOf(':') + 1).toLowerCase();
  return SECRET_SUFFIXES.some((s) => leaf.endsWith(s.toLowerCase()));
}

export function isMaskedValue(value: string | null | undefined): boolean {
  return value === SECRET_SET || value === SECRET_UNSET;
}

/** The value of a config key from the cockpit's entry list, or null when the engine has no row. */
export function configValue(entries: readonly NewsConfigEntry[], key: string): string | null {
  return entries.find((e) => e.key === key)?.value ?? null;
}

/** Search query per key from `NewsIntel:Ingest:SearchQueriesJson`; an unreadable JSON yields an empty map. */
export function parseSearchQueries(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k.toUpperCase()] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Adds or removes keys from a tracked list; returns the comma list the engine stores. */
export function editExposureList(current: readonly string[], add: readonly string[], remove: readonly string[]): string {
  const drop = new Set(remove.map((k) => k.toUpperCase()));
  const out = current.filter((k) => !drop.has(k));
  for (const k of add.map((x) => x.toUpperCase())) if (exposureKindOf(k) && !out.includes(k)) out.push(k);
  return out.join(',');
}

/** Groups keys by kind, in the kind order the classifier prompt uses. */
export function groupKeysByKind(keys: readonly string[]): { kind: ExposureKindName; keys: string[] }[] {
  const order: ExposureKindName[] = ['Currency', 'Commodity', 'EquityIndex', 'Equity', 'Crypto', 'Factor'];
  return order
    .map((kind) => ({ kind, keys: keys.filter((k) => exposureKindOf(k) === kind) }))
    .filter((g) => g.keys.length > 0);
}

// ── Vendors ──────────────────────────────────────────────────────────────

export const NEWS_VENDORS = ['Benzinga', 'Polygon', 'Finnhub', 'Marketaux'] as const;

export interface VendorRow {
  name: string;
  enabledKey: string;
  apiKeyKey: string;
  /** null = no config row (engine default: off). */
  enabled: boolean | null;
  /** set | unset | unknown (no row listed). */
  keyState: 'set' | 'unset' | 'unknown';
  /** Enabled without a key: the engine skips it and says so in sourceNotes. */
  blocked: boolean;
}

export function vendorRows(entries: readonly NewsConfigEntry[]): VendorRow[] {
  return NEWS_VENDORS.map((name) => {
    const enabledKey = `NewsIntel:Vendor:${name}:Enabled`;
    const apiKeyKey = `NewsIntel:Vendor:${name}:ApiKey`;
    const en = configValue(entries, enabledKey);
    const k = configValue(entries, apiKeyKey);
    const enabled = en === null ? null : en.trim().toLowerCase() === 'true';
    const keyState: VendorRow['keyState'] =
      k === null ? 'unknown' : k === SECRET_SET ? 'set' : k === SECRET_UNSET || k === '' ? 'unset' : 'set';
    return { name, enabledKey, apiKeyKey, enabled, keyState, blocked: enabled === true && keyState !== 'set' };
  });
}

/**
 * A short, non-reversible tag of a value the operator just pasted, shown only in this browser session
 * so they can tell which key they saved. The engine itself never returns key material.
 */
export function pastedKeyTag(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return `${v.length} characters`;
  return `…${v.slice(-4)} (${v.length} characters)`;
}

// ── Sources: latency + conditional GET ──────────────────────────────────

export interface LatencyRow {
  channel: string;
  source: string | null;
  day: { count: number; p50: number; p90: number } | null;
  week: { count: number; p50: number; p90: number } | null;
}

/** Joins the 24 h and 7 d rows of each channel / publisher into one row; channels first, slowest p50 (7 d) first. */
export function latencyRows(latency: readonly NewsSourceLatencyView[] | null | undefined): {
  channels: LatencyRow[];
  publishers: LatencyRow[];
} {
  const map = new Map<string, LatencyRow>();
  for (const v of latency ?? []) {
    const id = `${v.channel}|${v.source ?? ''}`;
    const row = map.get(id) ?? { channel: v.channel, source: v.source, day: null, week: null };
    const cell = { count: v.count, p50: v.p50Minutes, p90: v.p90Minutes };
    if (v.windowHours <= 24) row.day = cell;
    else row.week = cell;
    map.set(id, row);
  }
  const rows = [...map.values()];
  const bySlowest = (a: LatencyRow, b: LatencyRow) =>
    (b.week?.p50 ?? b.day?.p50 ?? -1) - (a.week?.p50 ?? a.day?.p50 ?? -1);
  return {
    channels: rows.filter((r) => r.source === null).sort(bySlowest),
    publishers: rows.filter((r) => r.source !== null).sort(bySlowest),
  };
}

/** "18m", "1h 10m", "17h", "2d 3h". */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h < 10 && r ? `${h}h ${r}m` : `${h}h`;
  }
  const d = Math.floor(m / (60 * 24));
  const h = Math.round((m % (60 * 24)) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** Conditional-GET summary over the polled feeds. */
export function feedSummary(feeds: readonly NewsFeedStateView[] | null | undefined): {
  feeds: number;
  withValidators: number;
  lastNotModified: number;
  /** Share of feeds whose LAST poll answered 304 — a point-in-time hit rate, not a history. */
  hitRate: number | null;
  failing: number;
} {
  const list = feeds ?? [];
  const notModified = list.filter((f) => f.lastStatus === 304).length;
  return {
    feeds: list.length,
    withValidators: list.filter((f) => f.hasValidators).length,
    lastNotModified: notModified,
    hitRate: list.length ? notModified / list.length : null,
    failing: list.filter((f) => f.lastStatus >= 400 || f.lastStatus === 0).length,
  };
}

/** The host of a feed URL, for a compact table. */
export function feedHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Splits a status source note ("sec-edgar: OFF — set …") into its subject and its sentence. */
export function parseSourceNote(note: string): { subject: string; text: string } {
  const i = note.indexOf(':');
  if (i <= 0 || i > 40) return { subject: '', text: note };
  return { subject: note.slice(0, i).trim(), text: note.slice(i + 1).trim() };
}

// ── Scheduled market events ──────────────────────────────────────────────

export interface CalendarDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  events: ScheduledMarketEventRow[];
}

/** Groups events by UTC day after filtering by kind, exposure kind and impact. Events stay in time order. */
export function calendarDays(
  events: readonly ScheduledMarketEventRow[],
  filter: { kind?: string | null; exposureKind?: ExposureKindName | null; highOnly?: boolean } = {},
): CalendarDay[] {
  const days = new Map<string, ScheduledMarketEventRow[]>();
  const sorted = [...events].sort((a, b) => a.scheduledAtUtc.localeCompare(b.scheduledAtUtc));
  for (const e of sorted) {
    if (filter.kind && e.kind !== filter.kind) continue;
    if (filter.exposureKind && exposureKindOf(e.exposureKey) !== filter.exposureKind) continue;
    if (filter.highOnly && e.impact.toLowerCase() !== 'high') continue;
    const day = e.scheduledAtUtc.slice(0, 10);
    const list = days.get(day) ?? [];
    list.push(e);
    days.set(day, list);
  }
  return [...days.entries()].map(([day, list]) => ({ day, events: list }));
}

/** Counts per kind, most frequent first. */
export function countByKind(events: readonly ScheduledMarketEventRow[]): { kind: string; count: number }[] {
  const m = new Map<string, number>();
  for (const e of events) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
  return [...m.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
}

/** Human label for a scheduled-event kind. */
export function eventKindLabel(kind: string): string {
  switch (kind) {
    case 'RigCount':
      return 'Rig count';
    case 'OpecMeeting':
      return 'OPEC+';
    case 'OptionsExpiry':
      return 'Options expiry';
    case 'IndexRebalance':
      return 'Index rebalance';
    case 'TokenUnlock':
      return 'Token unlock';
    case 'CentralBankDecision':
      return 'Central-bank decision';
    default:
      return kind;
  }
}

// ── Stories ──────────────────────────────────────────────────────────────

export function storyExposures(story: Pick<NewsStoryView, 'exposures'>): string[] {
  return (story.exposures ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

export function storyStateCounts(stories: readonly NewsStoryView[]): Record<string, number> {
  const out: Record<string, number> = { Developing: 0, Confirmed: 0, Denied: 0, Resolved: 0 };
  for (const s of stories) out[s.state] = (out[s.state] ?? 0) + 1;
  return out;
}

/**
 * Sample instants across a story's life for its weight-over-time series: `points` evenly spaced from
 * first seen to min(last seen + tail, now). Each instant is read point-in-time by the engine.
 */
export function storySampleInstants(
  story: Pick<NewsStoryView, 'firstSeenUtc' | 'lastSeenUtc'>,
  now: Date,
  points = 8,
  tailHours = 6,
): string[] {
  const start = Date.parse(story.firstSeenUtc);
  const end = Math.min(now.getTime(), Date.parse(story.lastSeenUtc) + tailHours * 3_600_000);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return Number.isFinite(start) ? [new Date(Math.min(start + 60_000, now.getTime())).toISOString()] : [];
  }
  const n = Math.max(2, points);
  return Array.from({ length: n }, (_, i) => new Date(start + ((end - start) * (i + 1)) / n).toISOString());
}

/** Contributor shape the pressure endpoint returns (engine `NewsWeightContribution`). */
export interface PressureContribution {
  articleId: number;
  title: string;
  sourceName: string | null;
  currency: string;
  ageMinutes: number;
  weight: number;
  signedWeight: number;
  storyId?: number | null;
  storyState?: string | null;
  lifecycleFactor?: number;
}

/** Engine `NewsPressureReading` (GET /news-intel/pressure). */
export interface NewsPressureReadingView {
  currency: string;
  asOfUtc: string;
  weightedScore: number;
  absolutePressure: number;
  articleCount: number;
  storyCount: number;
  dominantCategory: string | null;
  topContributors: PressureContribution[];
  paramsFingerprint: string;
}

/** A story's summed weight (and signed weight) per exposure key in one pressure answer. */
export function storyWeightIn(
  readings: readonly NewsPressureReadingView[],
  storyId: number,
): { total: number; signed: number; members: PressureContribution[] } {
  let total = 0;
  let signed = 0;
  const members: PressureContribution[] = [];
  for (const r of readings) {
    for (const c of r.topContributors ?? []) {
      if (c.storyId === storyId) {
        total += Math.abs(c.weight);
        signed += c.signedWeight;
        members.push(c);
      }
    }
  }
  return { total, signed, members };
}

// ── Evaluation metrics (MetricsJson) ─────────────────────────────────────

export interface BinaryScore {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface FieldScore {
  pairs: number;
  accuracy: number | null;
  macroF1: number | null;
  perClassF1: Record<string, number>;
}

export interface EvalPass {
  articles: number;
  articlesWithVerdict: number;
  relevance: BinaryScore | null;
  exposurePairs: BinaryScore | null;
  category: FieldScore | null;
  direction: FieldScore | null;
  certainty: FieldScore | null;
  relevanceMae: number | null;
  stanceAccuracy: number | null;
  sameEventPairs: BinaryScore | null;
}

export interface EvalMetrics {
  trackedKeys: string[];
  reviewedOnly: boolean;
  draftShare: number | null;
  passes: EvalPass[];
  agreement: {
    articles: number;
    relevance: number | null;
    exposureSet: number | null;
    categoryAndDirection: number | null;
    overall: number | null;
  } | null;
  triage: { mode: string; precision: number | null; recall: number | null; screenedOut: number } | null;
}

/** Reads a property in camelCase or PascalCase (the engine serialises the records with default naming). */
function pick(o: unknown, name: string): unknown {
  if (!o || typeof o !== 'object') return undefined;
  const r = o as Record<string, unknown>;
  if (name in r) return r[name];
  const pascal = name.charAt(0).toUpperCase() + name.slice(1);
  return r[pascal];
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function binary(o: unknown): BinaryScore | null {
  if (!o || typeof o !== 'object') return null;
  return {
    tp: num(pick(o, 'truePositive')) ?? 0,
    fp: num(pick(o, 'falsePositive')) ?? 0,
    fn: num(pick(o, 'falseNegative')) ?? 0,
    tn: num(pick(o, 'trueNegative')) ?? 0,
    precision: num(pick(o, 'precision')),
    recall: num(pick(o, 'recall')),
    f1: num(pick(o, 'f1')),
  };
}

function field(o: unknown): FieldScore | null {
  if (!o || typeof o !== 'object') return null;
  const per = pick(o, 'perClassF1');
  const perClassF1: Record<string, number> = {};
  if (per && typeof per === 'object') {
    for (const [k, v] of Object.entries(per as Record<string, unknown>)) if (typeof v === 'number') perClassF1[k] = v;
  }
  return {
    pairs: num(pick(o, 'pairs')) ?? 0,
    accuracy: num(pick(o, 'accuracy')),
    macroF1: num(pick(o, 'macroF1')),
    perClassF1,
  };
}

/** Parses a run's MetricsJson; null when absent or unreadable (never throws). */
export function parseEvalMetrics(json: string | null | undefined): EvalMetrics | null {
  if (!json) return null;
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  if (!root || typeof root !== 'object') return null;
  const passesRaw = pick(root, 'passes');
  const passes: EvalPass[] = Array.isArray(passesRaw)
    ? passesRaw.map((p) => ({
        articles: num(pick(p, 'articles')) ?? 0,
        articlesWithVerdict: num(pick(p, 'articlesWithVerdict')) ?? 0,
        relevance: binary(pick(p, 'relevance')),
        exposurePairs: binary(pick(p, 'exposurePairs')),
        category: field(pick(p, 'category')),
        direction: field(pick(p, 'direction')),
        certainty: field(pick(p, 'certainty')),
        relevanceMae: num(pick(p, 'relevanceMae')),
        stanceAccuracy: num(pick(p, 'stanceAccuracy')),
        sameEventPairs: binary(pick(p, 'sameEventPairs')),
      }))
    : [];
  const a = pick(root, 'agreement');
  const t = pick(root, 'triage');
  const keys = pick(root, 'trackedKeys');
  return {
    trackedKeys: Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [],
    reviewedOnly: pick(root, 'reviewedOnly') === true,
    draftShare: num(pick(root, 'draftShare')),
    passes,
    agreement:
      a && typeof a === 'object'
        ? {
            articles: num(pick(a, 'articles')) ?? 0,
            relevance: num(pick(a, 'relevance')),
            exposureSet: num(pick(a, 'exposureSet')),
            categoryAndDirection: num(pick(a, 'categoryAndDirection')),
            overall: num(pick(a, 'overall')),
          }
        : null,
    triage:
      t && typeof t === 'object'
        ? {
            mode: String(pick(t, 'mode') ?? ''),
            precision: num(pick(t, 'precision')),
            recall: num(pick(t, 'recall')),
            screenedOut: num(pick(t, 'screenedOut')) ?? 0,
          }
        : null,
  };
}

/** A run is still working (poll it) when Running; Abandoned is the engine's verdict on a stale Running row. */
export function evalRunActive(run: Pick<NewsEvalRunView, 'status'> | null | undefined): boolean {
  return run?.status === 'Running';
}

/** Caveat line for a run graded mostly against agent drafts. */
export function draftCaveat(run: Pick<NewsEvalRunView, 'draftLabelCount' | 'articleCount'>, draftShare: number | null): string | null {
  if (draftShare !== null && draftShare > 0) {
    return `${Math.round(draftShare * 100)}% of the gold labels this run used are agent drafts nobody has reviewed — read the scores as version-vs-version, not absolute.`;
  }
  if (run.draftLabelCount > 0) {
    return `${run.draftLabelCount} gold label(s) in this run are unreviewed agent drafts — read the scores as version-vs-version, not absolute.`;
  }
  return null;
}

// ── Formatting ───────────────────────────────────────────────────────────

/** "0.785" or "—". */
export function fmt(v: number | null | undefined, digits = 3): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

/** "78%" or "—". */
export function pct(v: number | null | undefined, digits = 0): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`;
}

/** "+0.123" / "−0.045" / "—". */
export function signed(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
}

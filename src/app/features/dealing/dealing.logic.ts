import type { EChartsOption } from 'echarts';

import { quotaRefusalOf } from '@core/plans/quota-refusal';
import type {
  CurveSeries,
  DealingAlert,
  DealingClients,
  DealingCurves,
  DealingFeed,
  DealingWindow,
  HorizonStat,
} from './dealing.types';

/** The horizons the engine reports, in order. */
export const HORIZONS_MS = [1_000, 5_000, 30_000, 60_000, 300_000] as const;

export function horizonLabel(ms: number): string {
  return ms >= 60_000 ? `${ms / 60_000} min` : `${ms / 1_000} s`;
}

export type WindowPreset = '24h' | '7d' | '30d' | '90d';

/** A window ending at `now` (rounded up to the next minute so repeated reads share a cache-friendly bound). */
export function windowFor(preset: WindowPreset, now: Date = new Date()): DealingWindow {
  const to = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  const hours = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 }[preset];
  return {
    fromUtc: new Date(to.getTime() - hours * 3_600_000).toISOString(),
    toUtc: to.toISOString(),
  };
}

/** True when the error is the plan refusing the broker module (show the upgrade notice, not an error). */
export function isModuleNotInPlan(err: unknown): boolean {
  const r = quotaRefusalOf(err);
  if (r) return r.quota === 'feature' && r.feature === 'brokerModule';
  // The refusal without its data (an older engine): the code + the module named in the message.
  const e = err as {
    response?: { responseCode?: unknown; message?: unknown };
    responseCode?: unknown;
    message?: unknown;
  } | null;
  const code = e?.response?.responseCode ?? e?.responseCode;
  const msg = String(e?.response?.message ?? e?.message ?? '');
  return code === '-403-quota' && /broker dealing-desk module/i.test(msg);
}

/** "+1.25" / "−0.40" / "—" (pips). */
export function pips(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(digits);
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

export function percent(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function holdText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3_600) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}

/** Chip tone of a classification. */
export function classificationTone(c: string): 'bad' | 'warn' | 'ok' | 'muted' {
  return c === 'toxic' ? 'bad' : c === 'watch' ? 'warn' : c === 'benign' ? 'ok' : 'muted';
}

export function classificationLabel(c: string): string {
  return (
    { toxic: 'Toxic', watch: 'Watch', benign: 'Benign', 'insufficient-data': 'Too few fills' }[c] ??
    c
  );
}

/** ADVISORY wording of a suggestion — never an instruction. */
export function suggestionLabel(s: string): string {
  return (
    {
      'a-book-candidate': 'A-book candidate',
      'b-book-candidate': 'B-book candidate',
      'no-change': 'No change suggested',
      none: '—',
    }[s] ?? s
  );
}

export function severityTone(a: Pick<DealingAlert, 'severity'>): 'bad' | 'warn' | 'muted' {
  return a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : 'muted';
}

/** The mean at a horizon of a curve, or null. */
export function at(
  markouts: readonly HorizonStat[] | undefined,
  horizonMs: number,
): HorizonStat | null {
  return markouts?.find((m) => m.horizonMs === horizonMs) ?? null;
}

/** Net open lots as text: "EURUSD +80, GBPUSD −3". */
export function netLotsText(net: Record<string, number> | null | undefined): string {
  const entries = Object.entries(net ?? {}).filter(([, v]) => Math.abs(v) > 1e-9);
  if (!entries.length) return '—';
  return entries
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(
      ([s, v]) =>
        `${s} ${v > 0 ? '+' : '−'}${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
    )
    .join(', ');
}

/** Markout curves: mean per horizon per series, with the 95 % band of the "all" series. */
export function curveChart(all: CurveSeries | null, series: readonly CurveSeries[]): EChartsOption {
  const x = HORIZONS_MS.map(horizonLabel);
  const line = (s: CurveSeries, width = 1.5) => ({
    name: `${s.key} (${s.fills})`,
    type: 'line' as const,
    symbolSize: 5,
    lineStyle: { width },
    data: HORIZONS_MS.map((h) => at(s.markouts, h)?.mean ?? null),
    connectNulls: true,
  });
  const out: EChartsOption['series'] = [];
  if (all) {
    out.push({ ...line(all, 3), name: `all (${all.fills})` });
    // 95 % CI band of the mean of all fills (stacked: lower + width).
    const lower = HORIZONS_MS.map((h) => {
      const s = at(all.markouts, h);
      return s?.mean != null && s.ci95 != null ? s.mean - s.ci95 : null;
    });
    const width = HORIZONS_MS.map((h) => at(all.markouts, h)?.ci95 ?? null).map((c) =>
      c == null ? null : 2 * c,
    );
    out.push({
      name: 'all 95% CI',
      type: 'line',
      stack: 'ci',
      data: lower,
      lineStyle: { opacity: 0 },
      symbol: 'none',
      silent: true,
    });
    out.push({
      name: 'all 95% CI',
      type: 'line',
      stack: 'ci',
      data: width,
      lineStyle: { opacity: 0 },
      symbol: 'none',
      areaStyle: { opacity: 0.12 },
      silent: true,
    });
  }
  for (const s of series) out.push(line(s));
  return {
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) => (typeof v === 'number' ? `${pips(v)} pips` : '—'),
    },
    legend: { type: 'scroll', top: 0 },
    grid: { left: 48, right: 16, top: 36, bottom: 32 },
    xAxis: {
      type: 'category',
      data: x,
      name: 'after the fill',
      nameLocation: 'middle',
      nameGap: 24,
    },
    yAxis: {
      type: 'value',
      name: 'pips (client +)',
      axisLabel: { formatter: (v: number) => pips(v, 1) },
    },
    series: out,
  };
}

/** A safe file name for a downloaded CSV. */
export function csvFileName(w: DealingWindow): string {
  const d = (s: string) => s.slice(0, 10).replaceAll('-', '');
  return `ab-book-suggestions-${d(w.fromUtc)}-${d(w.toUtc)}.csv`;
}

/** Writer ids typed one per line / comma separated → a clean unique list. */
export function parseWriters(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0),
    ),
  ];
}

export const FEED_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** What is wrong with a feed form (empty = can be saved). */
export function feedProblems(f: {
  feedId: string;
  displayName: string;
  writersText: string;
  create: boolean;
}): string[] {
  const problems: string[] = [];
  if (f.create && !FEED_ID.test(f.feedId.trim()))
    problems.push(
      'The feed id is lowercase letters, digits and dashes (up to 64), starting with a letter or digit.',
    );
  if (f.create && f.feedId.trim() === 'own')
    problems.push("'own' is reserved for the organisation's own accounts.");
  if (!f.displayName.trim()) problems.push('Give the feed a display name.');
  const writers = parseWriters(f.writersText);
  if (writers.length > 20) problems.push('At most 20 gateway identities.');
  if (writers.some((w) => w.length > 64))
    problems.push('A gateway identity is at most 64 characters.');
  return problems;
}

export interface DeskTile {
  label: string;
  value: string;
  hint: string;
  tone?: 'pos' | 'neg' | '';
  title?: string;
}

const WINDOW_WORDS: Record<WindowPreset, string> = {
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days',
};

/**
 * The desk's headline tiles from the tabs' own reads. Markouts are pips, POSITIVE = the price moved in the client's
 * favour (a cost to whoever took the other side), so a positive 60 s markout is shown in the loss colour for the desk.
 * Unknown (a read failed) shows "—", never 0.
 */
export function deskSummary(
  p: {
    clients: DealingClients | null;
    curves: DealingCurves | null;
    alerts: DealingAlert[] | null;
    feeds: DealingFeed[] | null;
  },
  preset: WindowPreset,
): DeskTile[] {
  const words = WINDOW_WORDS[preset] ?? preset;
  const all = p.curves?.all ?? null;
  const m60 = all?.markouts.find((h) => h.horizonMs === 60_000) ?? null;
  const critical = (p.alerts ?? []).filter((a) => a.severity === 'critical').length;
  const external = (p.feeds ?? []).filter((f) => f.feedId !== 'own');
  return [
    {
      label: 'Clients',
      value: p.clients ? String(p.clients.totalClients) : '—',
      hint: `with fills, ${words}`,
    },
    {
      label: 'Fills',
      value: all ? String(all.fills) : '—',
      hint: m60 ? `${m60.n} with a 60 s markout` : words,
    },
    {
      label: 'Volume',
      value: all ? `${all.volumeLots.toFixed(2)} lots` : '—',
      hint: 'sum of filled lots',
    },
    {
      label: 'Mean markout at 60 s',
      value: m60?.mean != null ? `${pips(m60.mean)} pips` : '—',
      hint:
        m60?.ci95 != null
          ? `± ${m60.ci95.toFixed(2)} (95 %) · t = ${m60.tStat?.toFixed(1) ?? 'n/a'}`
          : 'positive = moved in the client’s favour',
      tone: m60?.mean == null || m60.mean === 0 ? '' : m60.mean > 0 ? 'neg' : 'pos',
      title:
        'Positive = the price moved in the client’s favour after the fill (adverse for the desk).',
    },
    {
      label: 'Alerts',
      value: p.alerts ? String(p.alerts.length) : '—',
      hint: p.alerts ? `${critical} critical · computed on read` : 'computed on read',
      tone: critical > 0 ? 'neg' : '',
    },
    {
      label: 'Trade feeds',
      value: p.feeds ? String(external.length) : '—',
      hint: external.length
        ? `${external.filter((f) => f.enabled).length} enabled`
        : 'own accounts analysed (feed "own")',
    },
  ];
}

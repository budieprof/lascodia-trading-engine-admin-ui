/**
 * The catalogue the "Indicators, metrics and strategies" dialog browses.
 *
 * Every source (built-in indicators, profiles, patterns, Pine scripts and
 * strategies, FX fundamentals) is flattened into one `DialogItem` shape, so the
 * dialog knows nothing about any of them — the page maps a pick back to the
 * owning subsystem by `kind`.
 */

export type DialogTab = 'indicators' | 'strategies' | 'profiles' | 'patterns' | 'fundamentals';

export type DialogItemKind =
  | 'indicator'
  | 'strategy'
  | 'script'
  | 'profile'
  | 'candle-pattern'
  | 'chart-pattern'
  | 'fundamental';

export interface DialogItem {
  kind: DialogItemKind;
  id: string;
  name: string;
  description?: string;
  /** Sidebar grouping inside a tab ("Oscillators", "My scripts", "Candlestick"…). */
  category: string;
  /** Short right-aligned tag ("overlay", "pane", "bullish"…). */
  tag?: string;
  keywords?: string[];
}

export const TAB_FOR_KIND: Record<DialogItemKind, DialogTab> = {
  indicator: 'indicators',
  script: 'indicators',
  strategy: 'strategies',
  profile: 'profiles',
  'candle-pattern': 'patterns',
  'chart-pattern': 'patterns',
  fundamental: 'fundamentals',
};

export const DIALOG_TABS: { id: DialogTab; label: string }[] = [
  { id: 'indicators', label: 'Indicators' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'patterns', label: 'Patterns' },
  { id: 'fundamentals', label: 'Fundamentals' },
];

export const FAVOURITES = 'Favourites';
export const ALL = 'All';

export function itemKey(item: Pick<DialogItem, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`;
}

/**
 * Case-insensitive search over name, id, category and keywords. Every
 * whitespace-separated term must match somewhere ("rsi stoch" finds Stoch RSI).
 * A search spans every tab, like TradingView's.
 */
export function matchesQuery(item: DialogItem, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [item.name, item.id, item.category, item.tag ?? '', ...(item.keywords ?? [])]
    .join(' ')
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** Ranks exact/prefix name matches above substring hits. */
function rank(item: DialogItem, query: string): number {
  const q = query.trim().toLowerCase();
  const n = item.name.toLowerCase();
  if (!q) return 0;
  if (n === q || item.id.toLowerCase() === q) return 0;
  if (n.startsWith(q)) return 1;
  return 2;
}

export function categoriesFor(items: DialogItem[], tab: DialogTab): string[] {
  const seen = new Set<string>();
  for (const it of items) if (TAB_FOR_KIND[it.kind] === tab) seen.add(it.category);
  return [ALL, FAVOURITES, ...seen];
}

export function filterItems(
  items: DialogItem[],
  opts: { tab: DialogTab; category: string; query: string; favourites: ReadonlySet<string> },
): DialogItem[] {
  const q = opts.query.trim();
  if (q) {
    return items
      .filter((it) => matchesQuery(it, q))
      .map((it, i) => ({ it, i, r: rank(it, q) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.it);
  }
  return items.filter((it) => {
    if (TAB_FOR_KIND[it.kind] !== opts.tab) return false;
    if (opts.category === ALL) return true;
    if (opts.category === FAVOURITES) return opts.favourites.has(itemKey(it));
    return it.category === opts.category;
  });
}

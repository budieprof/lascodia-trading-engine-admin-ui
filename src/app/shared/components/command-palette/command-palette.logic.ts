import type { LucideIconData } from '@lucide/angular';

import { NAV_GROUPS } from '../../../layout/sidebar/nav-items';
import { navIcon } from '../../../layout/sidebar/nav-icons';

/** One row the palette can open: a page, or an entity found by the global search. */
export interface PaletteCommand {
  group: string;
  label: string;
  route: string;
  keywords?: string;
}

/** A run of rows under one heading; `start` is the flat index of its first row. */
export interface PaletteSection {
  group: string;
  start: number;
  items: PaletteCommand[];
}

/** A piece of a label, marked when it matches part of the query. */
export interface LabelSegment {
  text: string;
  hit: boolean;
}

/** Lower-cased words of the query, empty words dropped. */
export function queryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Rows grouped under their heading, headings in the order they first appear. Keyboard navigation
 * walks the flattened list, so the flat order and the drawn order must be the same: the palette
 * flattens what this returns rather than the input.
 */
export function groupCommands(commands: readonly PaletteCommand[]): PaletteSection[] {
  const byGroup = new Map<string, PaletteCommand[]>();
  for (const c of commands) {
    const list = byGroup.get(c.group);
    if (list) list.push(c);
    else byGroup.set(c.group, [c]);
  }
  const sections: PaletteSection[] = [];
  let start = 0;
  for (const [group, items] of byGroup) {
    sections.push({ group, start, items });
    start += items.length;
  }
  return sections;
}

/**
 * Pages that match every query word, best first: a label that starts with the query, then a label
 * containing every word, then matches found only in the route or keywords. Ties keep catalogue
 * order, so a section still reads in the sidebar's order. "pos" puts Positions above Dashboard,
 * which matches only because its description mentions open positions.
 */
export function rankCommands(
  commands: readonly PaletteCommand[],
  tokens: readonly string[],
): PaletteCommand[] {
  if (tokens.length === 0) return [...commands];
  const phrase = tokens.join(' ');
  const scored: { c: PaletteCommand; score: number; i: number }[] = [];
  commands.forEach((c, i) => {
    const hay = `${c.group} ${c.label} ${c.route} ${c.keywords ?? ''}`.toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) return;
    const label = c.label.toLowerCase();
    const words = label.split(/[\s\-—·/]+/);
    let score = 3;
    if (label.startsWith(phrase)) score = 0;
    else if (tokens.every((t) => words.some((w) => w.startsWith(t)))) score = 1;
    else if (tokens.every((t) => label.includes(t))) score = 2;
    scored.push({ c, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.c);
}

/** The label cut into matched and unmatched pieces, for highlighting what the query found. */
export function highlightSegments(label: string, tokens: readonly string[]): LabelSegment[] {
  if (tokens.length === 0 || !label) return [{ text: label, hit: false }];
  const lower = label.toLowerCase();
  const marks = new Array<boolean>(label.length).fill(false);
  for (const t of tokens) {
    let from = 0;
    for (let i = lower.indexOf(t, from); i >= 0; i = lower.indexOf(t, from)) {
      for (let k = i; k < i + t.length; k++) marks[k] = true;
      from = i + t.length;
    }
  }
  const out: LabelSegment[] = [];
  for (let i = 0; i < label.length; i++) {
    const last = out.at(-1);
    if (last && last.hit === marks[i]) last.text += label[i];
    else out.push({ text: label[i], hit: marks[i] });
  }
  return out;
}

// The sidebar draws Dashboard outside NAV_GROUPS, with this icon.
const ROUTE_ICONS: ReadonlyArray<readonly [string, LucideIconData]> = [
  ['/dashboard', navIcon.LayoutDashboard] as const,
  ...NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.route, i.icon] as const)),
].sort((a, b) => b[0].length - a[0].length);

/**
 * The sidebar's icon for a route, so a page looks the same in the palette as in the menu. A route
 * the sidebar does not list (a detail page, a search hit) takes the icon of the closest listed
 * parent: `/orders/42` draws as Orders.
 */
export function iconForRoute(route: string): LucideIconData {
  const path = route.split(/[?#]/)[0];
  for (const [r, icon] of ROUTE_ICONS) {
    if (path === r || path.startsWith(r + '/')) return icon;
  }
  return navIcon.FileText;
}

/** The route as a readable trail: `/positions/event-exposure` → `positions › event exposure`. */
export function routeTrail(route: string): string {
  return route
    .split(/[?#]/)[0]
    .split('/')
    .filter(Boolean)
    .map((p) => p.replace(/-/g, ' '))
    .join(' › ');
}

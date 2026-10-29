/**
 * Reads what a console page is SHOWING, as structure, for the assistant's `page.read` command.
 *
 * <p>Most pages publish no facts, so before this the assistant could see a page only when the
 * operator shared their screen. This gives it the same view any operator has — headings, the
 * figures in the tiles, feature status cards, tabs, tables, notices — on every page, with no
 * per-page code.</p>
 *
 * <p>It returns what the PAGE rendered, which includes data (a broker comment in a table cell, a
 * headline). That is why it is a command and not part of the page context: a command's result
 * reaches the model as a tool result, fenced as untrusted data, never as instructions.</p>
 */

const TEXT_CAP = 160;
const DEFAULT_ROWS = 10;
const MAX_ROWS = 40;
const MAX_TABLES = 8;
const MAX_ITEMS = 40;

/** Same selector the visual-review crawler uses to find tabs. */
export const TAB_SELECTOR =
  '[role="tab"], .tabs button, .tabs a, .tab-bar button, .tab-bar a, nav.tabs button, .subnav a, .pill-tabs button';

export interface PageReadTable {
  /** The nearest heading above the table, if any. */
  heading: string | null;
  columns: string[];
  /** Rows the page has rendered (a virtualised grid renders only what is in view). */
  renderedRows: number;
  rows: string[][];
}

export interface PageReadResult {
  title: string | null;
  /** Section headings in page order. */
  sections: string[];
  /** Feature status cards: whether a feature is on, its switch, and what it still needs. */
  featureStates: Array<{
    state: string;
    title: string;
    switchKey: string | null;
    summary: string;
    needs: Array<{ label: string; ok: boolean | null; detail: string | null }>;
  }>;
  /** Tiles and KPI figures: label → value as displayed. */
  figures: Array<{ label: string; value: string }>;
  tabs: Array<{ label: string; active: boolean }>;
  tables: PageReadTable[];
  /** Empty states, warnings and banners. */
  notices: string[];
  /** Set when `section` was asked for and matched nothing, so the whole page was read. */
  sectionNotFound?: string;
}

/** The page's main content element — never the dock, nav rail or footer. */
export function pageRoot(doc: Document = document): HTMLElement {
  return (
    (doc.querySelector('main .page') as HTMLElement | null) ??
    (doc.querySelector('main') as HTMLElement | null) ??
    doc.body
  );
}

export function readPage(
  root: HTMLElement,
  opts: { section?: string | null; rows?: number | null } = {},
): PageReadResult {
  const rowsWanted = clamp(opts.rows ?? DEFAULT_ROWS, 1, MAX_ROWS);
  let scope: HTMLElement = root;
  let sectionNotFound: string | undefined;
  if (opts.section?.trim()) {
    const found = findSection(root, opts.section.trim());
    if (found) scope = found;
    else sectionNotFound = opts.section.trim();
  }

  const visible = (el: Element) => isVisible(el as HTMLElement);

  const title = text(root.querySelector('h1')) || null;
  const sections = uniq(
    [...scope.querySelectorAll('h2, h3, .section-title, .card-title, .card-head h2, .card-head h3')]
      .filter(visible)
      .map((h) => text(h)),
  ).slice(0, MAX_ITEMS);

  const featureStates = [...scope.querySelectorAll('app-feature-state .fs')]
    .filter(visible)
    .map((fs) => ({
      state: text(fs.querySelector('.pill')),
      title: text(fs.querySelector('.title')),
      switchKey: text(fs.querySelector('.key')) || null,
      summary: text(fs.querySelector('.summary')),
      needs: [...fs.querySelectorAll('.reqs li')].map((li) => {
        const ok = li.getAttribute('data-ok');
        return {
          label: text(li.querySelector('.req-label')),
          ok: ok === 'true' ? true : ok === 'false' ? false : null,
          detail: text(li.querySelector('.req-detail')) || null,
        };
      }),
    }));

  const figures: Array<{ label: string; value: string }> = [];
  const seenFigure = new Set<string>();
  const addFigure = (label: string, value: string) => {
    const key = `${label}=${value}`;
    if (!label || !value || seenFigure.has(key) || figures.length >= MAX_ITEMS * 2) return;
    seenFigure.add(key);
    figures.push({ label, value });
  };
  for (const card of scope.querySelectorAll('app-metric-card')) {
    if (!visible(card)) continue;
    addFigure(text(card.querySelector('.metric-label')), text(card.querySelector('.metric-value')));
  }
  // Pages' own KPI tiles: a small block with a label element and a value element.
  for (const tile of scope.querySelectorAll(
    '[class*="kpi"]:not([class*="kpis"]), [class*="stat-card"], [class*="tile"]:not([class*="tiles"])',
  )) {
    if (
      !visible(tile) ||
      tile.closest('app-metric-card') ||
      tile.querySelector('table, [role="grid"]')
    )
      continue;
    const label = tile.querySelector('[class*="label"], [class*="title"], dt, .name');
    const value = tile.querySelector('[class*="value"], [class*="num"], dd, strong');
    if (label && value && label !== value) addFigure(text(label), text(value));
  }
  // Definition lists (detail pages): term → value.
  for (const dl of scope.querySelectorAll('dl')) {
    if (!visible(dl)) continue;
    for (const dt of dl.querySelectorAll('dt')) {
      const dd = dt.nextElementSibling;
      if (dd?.tagName === 'DD') addFigure(text(dt), text(dd));
    }
  }

  const tabs = [...root.querySelectorAll(TAB_SELECTOR)]
    .filter(visible)
    .map((t) => ({ label: text(t), active: isActiveTab(t) }))
    .filter((t) => t.label);

  const tables: PageReadTable[] = [];
  for (const table of scope.querySelectorAll('table')) {
    if (tables.length >= MAX_TABLES) break;
    if (!visible(table) || table.closest('[role="grid"]')) continue;
    const columns = [...table.querySelectorAll('thead th')].map((th) => text(th));
    const bodyRows = [...table.querySelectorAll('tbody tr')];
    tables.push({
      heading: headingBefore(table, scope),
      columns,
      renderedRows: bodyRows.length,
      rows: bodyRows
        .slice(0, rowsWanted)
        .map((tr) => [...tr.querySelectorAll('td, th')].map((c) => text(c))),
    });
  }
  for (const grid of scope.querySelectorAll('[role="grid"], [role="treegrid"]')) {
    if (tables.length >= MAX_TABLES) break;
    if (!visible(grid)) continue;
    const columns = uniq([...grid.querySelectorAll('[role="columnheader"]')].map((h) => text(h)));
    const rows = [...grid.querySelectorAll('[role="row"]')].filter((r) =>
      r.querySelector('[role="gridcell"]'),
    );
    tables.push({
      heading: headingBefore(grid as HTMLElement, scope),
      columns,
      renderedRows: rows.length,
      rows: rows
        .slice(0, rowsWanted)
        .map((r) => [...r.querySelectorAll('[role="gridcell"]')].map((c) => text(c))),
    });
  }

  const notices = uniq(
    [
      ...scope.querySelectorAll(
        '[role="alert"], [role="status"]:not(app-feature-state .fs), .empty-state, app-empty-state, .banner, .notice, .warning, .callout',
      ),
    ]
      .filter(visible)
      .filter((el) => !el.closest('app-feature-state'))
      .map((el) => text(el)),
  ).slice(0, MAX_ITEMS);

  return {
    title,
    sections,
    featureStates,
    figures,
    tabs,
    tables,
    notices,
    ...(sectionNotFound ? { sectionNotFound } : {}),
  };
}

/** The tab whose label matches, best match first: exact, then starts-with, then contains. */
export function findTab(root: HTMLElement, label: string): HTMLElement | null {
  const want = norm(label);
  if (!want) return null;
  const tabs = [...root.querySelectorAll(TAB_SELECTOR)].filter((t) =>
    isVisible(t as HTMLElement),
  ) as HTMLElement[];
  return (
    tabs.find((t) => norm(text(t)) === want) ??
    tabs.find((t) => norm(text(t)).startsWith(want)) ??
    tabs.find((t) => norm(text(t)).includes(want)) ??
    null
  );
}

/** A tab-ish element whose label names an action (crawler rule): never click those as "tabs". */
export const ACTION_LABEL =
  /\b(test|send|save|delete|remove|clear|reset|apply|run|start|stop|enable|disable|approve|reject|flatten|kill|retry|replay|resolve|discard|sync|rotate|launch|trigger|engage|release|close|cancel|submit|activate|pause|resume)\b/i;

export function isActiveTab(el: Element): boolean {
  return (
    el.getAttribute('aria-selected') === 'true' ||
    el.getAttribute('aria-current') === 'page' ||
    el.classList.contains('active') ||
    el.classList.contains('selected') ||
    el.classList.contains('is-active')
  );
}

function findSection(root: HTMLElement, name: string): HTMLElement | null {
  const want = norm(name);
  const headings = [
    ...root.querySelectorAll('h1, h2, h3, h4, .section-title, .card-title'),
  ] as HTMLElement[];
  const match =
    headings.find((h) => norm(text(h)) === want) ??
    headings.find((h) => norm(text(h)).includes(want));
  if (!match) return null;
  // The section is the nearest container that holds more than the heading itself.
  let el: HTMLElement | null = match.parentElement;
  const len = (e: HTMLElement) => (e.innerText ?? e.textContent ?? '').trim().length;
  while (el && el !== root && len(el) <= len(match) + 2) el = el.parentElement;
  return el ?? root;
}

function headingBefore(el: HTMLElement, scope: HTMLElement): string | null {
  let node: HTMLElement | null = el;
  while (node && node !== scope.parentElement) {
    let sib = node.previousElementSibling as HTMLElement | null;
    while (sib) {
      const h = sib.matches('h1,h2,h3,h4,.section-title,.card-title')
        ? sib
        : (sib.querySelector('h1,h2,h3,h4,.section-title,.card-title') as HTMLElement | null);
      if (h && text(h)) return text(h);
      sib = sib.previousElementSibling as HTMLElement | null;
    }
    node = node.parentElement;
  }
  return null;
}

function isVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  // jsdom has no layout; treat "no layout information" as visible there.
  if (typeof el.getClientRects !== 'function') return true;
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return true;
}

function text(el: Element | null | undefined): string {
  if (!el) return '';
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? '';
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) + '…' : t;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));
}

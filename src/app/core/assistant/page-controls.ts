/**
 * Finds and drives a page's VIEW controls for the assistant: `page.listControls`, `page.setField`,
 * `page.click`.
 *
 * <p>Generic, like {@link readPage}: it works from the rendered DOM, so every page is covered with
 * no per-page code. It changes only what a page DISPLAYS — filters, search boxes, selects, date
 * ranges, sort, paging, "show more", expanding a row, opening a row's detail. Anything labelled
 * as an action is refused here, and the commands run under {@link AssistantWriteGuard}, which
 * refuses any request that is not a read: the two layers together mean a page control can never
 * become a way to change data without the operator's approval card.</p>
 */
import { ACTION_LABEL, TAB_SELECTOR, pageRoot } from './page-reader';

const LABEL_CAP = 80;
const VALUE_CAP = 80;
const MAX_FIELDS = 40;
const MAX_CONTROLS = 60;
const MAX_OPTIONS = 30;
const MAX_ROW_SAMPLES = 5;

/**
 * Labels that name a change, beyond the crawler's {@link ACTION_LABEL}: trading verbs, create /
 * edit flows, lifecycle moves. The write guard would refuse their requests anyway; refusing the
 * click too keeps the assistant from even opening a "Buy" confirmation it could never complete.
 */
const MORE_WRITE_WORDS =
  /\b(buy|sell|place|create|add|new|edit|update|modify|promote|demote|archive|unarchive|restore|confirm|execute|deploy|publish|unpublish|import|upload|generate|assign|unassign|revoke|grant|invite|rename|duplicate|clone|schedule|acknowledge|ack|snooze|mute|unmute|dismiss|mark|toggle|flip|export|download|print|sign out|log ?out|sign in|log ?in|connect|disconnect|terminate|liquidate|hedge|rebalance|retrain|train|backfill|purge|wipe|override|unlock|lock|block|unblock|ban|suspend|impersonate)\b/i;

/** True when a control's label names an action rather than a view change. */
export function isWriteLikeLabel(label: string): boolean {
  return ACTION_LABEL.test(label) || MORE_WRITE_WORDS.test(label);
}

/** Overlays the console opens on top of the page: dialogs, drawers, menus. */
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"], .cdk-overlay-pane, .drawer, [class*="drawer-panel"], [role="menu"], [role="listbox"]';

/** Never the assistant's own panel. */
const DOCK_SELECTOR = 'app-assistant-dock';

const SENSITIVE =
  /password|passcode|secret|token|api.?key|otp|one.?time|credential|private.?key|mnemonic|seed phrase|pin\b/i;

const CLICKABLE_SELECTOR = [
  'button',
  'a[href]',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[aria-expanded]',
  'th[aria-sort]',
  'th.sortable',
  '[role="columnheader"][aria-sort]',
  '.ag-header-cell[aria-sort]',
  'input[type="button"]',
].join(', ');

const ROW_SELECTOR = 'tbody tr, [role="row"]';

export type FieldKind = 'text' | 'search' | 'number' | 'date' | 'select' | 'checkbox' | 'radio';

export interface PageField {
  label: string;
  kind: FieldKind;
  /** Current value as displayed: the text, the selected option's label, true/false, the checked radio. */
  value: string | boolean | null;
  /** Select / radio choices (first 30). */
  options?: string[];
  optionsTotal?: number;
  /** Where it is when not on the page itself: "dialog: Filter positions". */
  where?: string;
  sensitive?: true;
  disabled?: true;
}

export type ControlKind =
  | 'button'
  | 'link'
  | 'expander'
  | 'pagination'
  | 'more'
  | 'sort'
  | 'switch';

export interface PageControl {
  label: string;
  kind: ControlKind;
  /** expander: "expanded"/"collapsed"; sort: "ascending"/"descending"/"none"; pagination: "current". */
  state?: string;
  /** A link's in-console path. */
  href?: string;
  /** How many controls share this label (e.g. a "Details" button per row) — use `within`. */
  repeats?: number;
  where?: string;
}

export interface PageRowsInfo {
  table: string | null;
  rows: number;
  /** Whether clicking a row opens something (a detail page, a drawer). */
  opensDetail: boolean;
  /** First cell of the first rows — text to pass as `within`. */
  sample: string[];
}

export interface PageControlsResult {
  fields: PageField[];
  controls: PageControl[];
  rows: PageRowsInfo[];
  /** Labels of controls the assistant may NOT click because they change data. */
  actionsNotClickable: string[];
}

/** The page plus any open overlay, page first. Overlays nested in the page are not repeated. */
export function controlScopes(
  doc: Document = document,
): Array<{ el: HTMLElement; where?: string }> {
  const root = pageRoot(doc);
  const scopes: Array<{ el: HTMLElement; where?: string }> = [{ el: root }];
  for (const el of doc.querySelectorAll(OVERLAY_SELECTOR) as NodeListOf<HTMLElement>) {
    if (el.closest(DOCK_SELECTOR) || !visible(el)) continue;
    // A menu inside an open dialog is part of that dialog.
    if (scopes.some((s) => s.el !== root && s.el.contains(el))) continue;
    scopes.push({ el, where: overlayWhere(el) });
  }
  // Callers walk overlays first and skip elements already seen, so an overlay rendered inside the
  // page is reported once, as the overlay.
  return scopes;
}

// ── Discovery ─────────────────────────────────────────────────────────────────────────────

export function listControls(doc: Document = document): PageControlsResult {
  const scopes = controlScopes(doc);
  const seen = new Set<Element>();
  const fields: PageField[] = [];
  const radioGroups = new Set<string>();
  const controlsByKey = new Map<string, PageControl>();
  const actions = new Set<string>();

  // Overlays first: what is open on top is what the operator is looking at.
  const ordered = [...scopes.slice(1), scopes[0]];
  for (const { el: scope, where } of ordered) {
    for (const el of scope.querySelectorAll('input, select, textarea') as NodeListOf<FormEl>) {
      if (seen.has(el) || !isFieldCandidate(el) || !visible(el) || el.closest(DOCK_SELECTOR))
        continue;
      seen.add(el);
      if (fields.length >= MAX_FIELDS) continue;
      if (el instanceof HTMLInputElement && el.type === 'radio') {
        const key = el.name || fieldLabel(el);
        if (radioGroups.has(key)) continue;
        radioGroups.add(key);
      }
      fields.push(describeField(el, where));
    }

    for (const el of scope.querySelectorAll(CLICKABLE_SELECTOR) as NodeListOf<HTMLElement>) {
      if (seen.has(el) || !visible(el) || el.closest(DOCK_SELECTOR)) continue;
      seen.add(el);
      if (el.matches(TAB_SELECTOR)) continue; // page.read / page.selectTab cover tabs
      if (isDisabled(el)) continue;
      // Controls inside table rows are row actions — summarised by label with a repeat count.
      const label = controlLabel(el);
      if (!label) continue;
      if (clickRefusal(el, label, doc)) {
        if (actions.size < 25) actions.add(label);
        continue;
      }
      const kind = controlKind(el, label);
      const key = `${kind}|${label.toLowerCase()}|${where ?? ''}`;
      const existing = controlsByKey.get(key);
      if (existing) {
        existing.repeats = (existing.repeats ?? 1) + 1;
        continue;
      }
      if (controlsByKey.size >= MAX_CONTROLS) continue;
      const control: PageControl = { label, kind };
      const state = controlState(el, kind);
      if (state) control.state = state;
      if (kind === 'link') control.href = inAppHref(el as HTMLAnchorElement, doc) ?? undefined;
      if (where) control.where = where;
      controlsByKey.set(key, control);
    }
  }

  return {
    fields,
    controls: [...controlsByKey.values()],
    rows: describeRows(scopes, doc),
    actionsNotClickable: [...actions],
  };
}

function describeRows(scopes: Array<{ el: HTMLElement }>, doc: Document): PageRowsInfo[] {
  const out: PageRowsInfo[] = [];
  const seen = new Set<Element>();
  for (const { el: scope } of scopes) {
    for (const table of scope.querySelectorAll('table, [role="grid"], [role="treegrid"]')) {
      if (seen.has(table) || !visible(table as HTMLElement) || table.closest(DOCK_SELECTOR))
        continue;
      seen.add(table);
      if (table.tagName === 'TABLE' && table.closest('[role="grid"]')) continue;
      const rows = bodyRows(table as HTMLElement);
      if (!rows.length) continue;
      out.push({
        table: tableHeading(table as HTMLElement),
        rows: rows.length,
        opensDetail: rows.slice(0, 3).some((r) => rowOpens(r, doc)),
        sample: rows
          .slice(0, MAX_ROW_SAMPLES)
          .map((r) => firstCellText(r))
          .filter(Boolean),
      });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

// ── Lookup ────────────────────────────────────────────────────────────────────────────────

/**
 * The element `within` names: the table row whose text contains it (an exact cell match wins,
 * then the shortest row), else the smallest section/card/list item containing it.
 */
export function findWithin(doc: Document, within: string): HTMLElement | null {
  const want = norm(within);
  if (!want) return null;
  const scopes = controlScopes(doc);
  const rows: HTMLElement[] = [];
  for (const { el } of scopes) {
    for (const r of el.querySelectorAll(ROW_SELECTOR) as NodeListOf<HTMLElement>) {
      if (!visible(r) || r.closest(DOCK_SELECTOR) || isHeaderRow(r)) continue;
      if (norm(text(r)).includes(want)) rows.push(r);
    }
  }
  if (rows.length) {
    const exact = rows.find((r) => cells(r).some((c) => norm(text(c)) === want));
    return exact ?? rows.sort((a, b) => text(a).length - text(b).length)[0];
  }
  const containers: HTMLElement[] = [];
  for (const { el } of scopes) {
    for (const c of el.querySelectorAll(
      'section, article, li, details, fieldset, form, [role="group"], [role="region"], [class*="card"], [class*="panel"]',
    ) as NodeListOf<HTMLElement>) {
      if (!visible(c) || c.closest(DOCK_SELECTOR)) continue;
      if (norm(text(c)).includes(want)) containers.push(c);
    }
  }
  if (!containers.length) return null;
  return containers.sort((a, b) => text(a).length - text(b).length)[0];
}

export function findField(
  doc: Document,
  label: string,
  within?: HTMLElement | null,
): FormEl | null {
  const want = norm(label);
  if (!want) return null;
  const roots = within ? [within] : controlScopes(doc).map((s) => s.el);
  const all: FormEl[] = [];
  for (const r of roots) {
    for (const el of r.querySelectorAll('input, select, textarea') as NodeListOf<FormEl>) {
      if (isFieldCandidate(el) && visible(el) && !el.closest(DOCK_SELECTOR) && !all.includes(el))
        all.push(el);
    }
  }
  const labelled = all.map((el) => ({ el, l: norm(fieldLabel(el)) }));
  return (
    labelled.find((x) => x.l === want)?.el ??
    labelled.find((x) => x.l.startsWith(want))?.el ??
    labelled.find((x) => x.l.includes(want))?.el ??
    // A radio is also found by one of its option labels ("Closed").
    all.find(
      (el) =>
        el instanceof HTMLInputElement &&
        el.type === 'radio' &&
        norm(optionLabelOfRadio(el)) === want,
    ) ??
    null
  );
}

export interface ClickTarget {
  el: HTMLElement;
  label: string;
  kind: ControlKind | 'row';
}

/**
 * Resolve `page.click`. With only `within` (a row), the row itself is opened. With a label, the
 * matching view control (inside `within` when given); failing that, a table cell with that exact
 * text opens its row.
 */
export function findClickTarget(
  doc: Document,
  label: string | null,
  within: HTMLElement | null,
): ClickTarget | null {
  const want = norm(label ?? '');
  if (!want) {
    if (!within) return null;
    const row = within.matches(ROW_SELECTOR) ? within : null;
    if (!row) return null;
    return { el: rowClickElement(row, doc), label: firstCellText(row) || 'row', kind: 'row' };
  }
  const roots = within
    ? [within]
    : controlScopes(doc)
        .map((s) => s.el)
        .reverse(); // overlays first
  const candidates: Array<{ el: HTMLElement; l: string }> = [];
  for (const r of roots) {
    const els = [
      ...(r.matches(CLICKABLE_SELECTOR) ? [r] : []),
      ...(r.querySelectorAll(`${CLICKABLE_SELECTOR}, ${TAB_SELECTOR}`) as NodeListOf<HTMLElement>),
    ];
    for (const el of els) {
      if (!visible(el) || el.closest(DOCK_SELECTOR) || candidates.some((c) => c.el === el))
        continue;
      candidates.push({ el, l: norm(controlLabel(el)) });
    }
  }
  const hit =
    candidates.find((c) => c.l === want) ??
    candidates.find((c) => c.l.startsWith(want)) ??
    candidates.find((c) => c.l.includes(want));
  if (hit) {
    const l = controlLabel(hit.el);
    return {
      el: hit.el,
      label: l,
      kind: hit.el.matches(TAB_SELECTOR) ? 'button' : controlKind(hit.el, l),
    };
  }
  // A cell whose text IS the label: open its row ("EURUSD").
  for (const r of roots) {
    for (const row of r.querySelectorAll(ROW_SELECTOR) as NodeListOf<HTMLElement>) {
      if (!visible(row) || isHeaderRow(row) || row.closest(DOCK_SELECTOR)) continue;
      const cell = cells(row).find((c) => norm(text(c)) === want);
      if (cell) {
        const link = [...cell.querySelectorAll('a[href]')][0] as HTMLElement | undefined;
        return { el: link ?? rowClickElement(row, doc), label: text(cell), kind: 'row' };
      }
    }
    if (within && within.matches(ROW_SELECTOR)) break;
  }
  return null;
}

// ── Refusals ──────────────────────────────────────────────────────────────────────────────

/** Why the assistant must not click this, or null when it may. */
export function clickRefusal(
  el: HTMLElement,
  label: string,
  doc: Document = document,
): string | null {
  if (el.closest(DOCK_SELECTOR)) return 'it is part of the assistant panel';
  if (isDisabled(el)) return `"${label}" is disabled`;
  const isTab = el.getAttribute('role') === 'tab';
  const names = [label, el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? ''].join(
    ' ',
  );
  if (!isTab && isWriteLikeLabel(names)) {
    return `"${label}" is an action that changes data, not a view control`;
  }
  const button = el.closest('button, input[type="submit"], input[type="image"]') as
    | HTMLButtonElement
    | HTMLInputElement
    | null;
  if (button && button.form && (button.type === 'submit' || button.type === 'image')) {
    return `"${label}" submits a form`;
  }
  const anchor = el.closest('a[href]') as HTMLAnchorElement | null;
  if (anchor) {
    const raw = anchor.getAttribute('href') ?? '';
    if (/^\s*(javascript|mailto|tel|data|blob):/i.test(raw)) return `"${label}" is not a page link`;
    if (anchor.hasAttribute('download')) return `"${label}" downloads a file`;
    let url: URL;
    try {
      url = new URL(raw, doc.baseURI);
    } catch {
      return `"${label}" has an unreadable link`;
    }
    if (url.origin !== new URL(doc.baseURI).origin)
      return `"${label}" leaves the console (${url.origin})`;
    if (/^\/(login|logout|signup|bff|api|scim)(\/|$)/i.test(url.pathname)) {
      return `"${label}" leads out of the console pages (${url.pathname})`;
    }
  }
  return null;
}

/** Why the assistant must not set this field, or null when it may. */
export function fieldRefusal(el: FormEl): string | null {
  const label = fieldLabel(el) || 'that field';
  if (el.closest(DOCK_SELECTOR)) return 'it is part of the assistant panel';
  if (isSensitive(el)) return `"${label}" holds a secret — the assistant never fills those`;
  if (el.disabled) return `"${label}" is disabled`;
  if ((el as HTMLInputElement).readOnly) return `"${label}" is read-only`;
  return null;
}

// ── Setting values ────────────────────────────────────────────────────────────────────────

export interface SetOutcome {
  ok: boolean;
  /** The value the field shows afterwards. */
  value: string | boolean | null;
  problem?: string;
}

/**
 * Set a field the way Angular sees a person typing: the native value setter (so a framework
 * wrapper's own setter is bypassed and the DOM really changes), then `input` + `change`. A
 * checkbox or radio is clicked, which fires the same events a real click does.
 */
export function setFieldValue(el: FormEl, raw: unknown): SetOutcome {
  const kind = fieldKind(el);
  el.dispatchEvent(new FocusEvent('focus'));
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

  if (kind === 'checkbox') {
    const want = toBool(raw);
    if (want === null)
      return { ok: false, value: (el as HTMLInputElement).checked, problem: 'use true or false' };
    if ((el as HTMLInputElement).checked !== want) el.click();
    return finish(el);
  }
  if (kind === 'radio') {
    const radio = pickRadio(el as HTMLInputElement, raw);
    if (!radio) {
      return {
        ok: false,
        value: currentValue(el),
        problem: `no option "${String(raw)}" — options: ${radioGroup(el as HTMLInputElement)
          .map(optionLabelOfRadio)
          .join(', ')}`,
      };
    }
    if (!radio.checked) radio.click();
    return finish(radio);
  }
  if (kind === 'select') {
    const sel = el as HTMLSelectElement;
    const option = pickOption(sel, String(raw ?? ''));
    if (!option) {
      return {
        ok: false,
        value: currentValue(el),
        problem: `no option "${String(raw)}" — options: ${[...sel.options].slice(0, MAX_OPTIONS).map(optionText).join(', ')}`,
      };
    }
    nativeSet(sel, option.value);
    sel.selectedIndex = option.index;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return finish(sel);
  }

  const value = raw === null || raw === undefined ? '' : String(raw);
  nativeSet(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (value !== '' && el.value === '') {
    const hint =
      kind === 'date'
        ? ` (${(el as HTMLInputElement).type} fields take e.g. ${dateExample(el as HTMLInputElement)})`
        : '';
    return { ok: false, value: '', problem: `the field did not accept "${value}"${hint}` };
  }
  return finish(el);
}

/**
 * Press Enter in a field — what a search box waits for. The key events reach Angular's
 * `(keydown.enter)` handlers; a browser does not submit a form for a synthetic key, so when the
 * field sits in a form that nothing handled, the form is submitted the way Enter would. The
 * write guard is up while this runs: Enter in a create form gets its request refused.
 */
export function pressEnter(el: FormEl): void {
  const init: KeyboardEventInit = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true };
  const down = new KeyboardEvent('keydown', init);
  // Older handlers read keyCode/which, which the KeyboardEvent constructor leaves at 0.
  Object.defineProperties(down, { keyCode: { get: () => 13 }, which: { get: () => 13 } });
  const handled = !el.dispatchEvent(down);
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  const form = el.form;
  if (!handled && form && typeof form.requestSubmit === 'function') {
    // Only a form whose own submit is not an action ("Search", "Filter", or none at all).
    const submits = [...form.querySelectorAll('button, input[type="submit"]')].filter(
      (b) => (b as HTMLButtonElement).type === 'submit',
    ) as HTMLElement[];
    if (submits.every((b) => !isWriteLikeLabel(controlLabel(b)))) form.requestSubmit();
  }
}

// ── Describing ────────────────────────────────────────────────────────────────────────────

export type FormEl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export function describeField(el: FormEl, where?: string): PageField {
  const kind = fieldKind(el);
  const sensitive = isSensitive(el);
  const field: PageField = {
    label: fieldLabel(el) || '(unlabelled)',
    kind,
    value: sensitive ? null : currentValue(el),
  };
  if (kind === 'select') {
    const opts = [...(el as HTMLSelectElement).options];
    field.options = opts.slice(0, MAX_OPTIONS).map(optionText);
    if (opts.length > MAX_OPTIONS) field.optionsTotal = opts.length;
  } else if (kind === 'radio') {
    const group = radioGroup(el as HTMLInputElement);
    field.label = radioGroupLabel(el as HTMLInputElement) || field.label;
    field.options = group.slice(0, MAX_OPTIONS).map(optionLabelOfRadio);
  }
  if (where) field.where = where;
  if (sensitive) field.sensitive = true;
  if (el.disabled) field.disabled = true;
  return field;
}

export function currentValue(el: FormEl): string | boolean | null {
  const kind = fieldKind(el);
  if (kind === 'checkbox') return (el as HTMLInputElement).checked;
  if (kind === 'radio') {
    const on = radioGroup(el as HTMLInputElement).find((r) => r.checked);
    return on ? optionLabelOfRadio(on) : null;
  }
  if (kind === 'select') {
    const sel = el as HTMLSelectElement;
    const o = sel.options[sel.selectedIndex];
    return o ? optionText(o) : null;
  }
  return cap(el.value, VALUE_CAP);
}

export function fieldKind(el: FormEl): FieldKind {
  if (el instanceof HTMLSelectElement) return 'select';
  if (el instanceof HTMLTextAreaElement) return 'text';
  switch (el.type) {
    case 'search':
      return 'search';
    case 'number':
    case 'range':
      return 'number';
    case 'date':
    case 'datetime-local':
    case 'month':
    case 'week':
    case 'time':
      return 'date';
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    default:
      return 'text';
  }
}

/**
 * A field's label, as a person reads it: `aria-label`, `aria-labelledby`, `<label for>`, the
 * wrapping `<label>` (minus the control's own text), a label-ish sibling in the same row, then
 * `placeholder`, `title`, `name`.
 */
export function fieldLabel(el: FormEl): string {
  const doc = el.ownerDocument;
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return cap(aria, LABEL_CAP);
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = by
      .split(/\s+/)
      .map((id) => text(doc.getElementById(id)))
      .join(' ')
      .trim();
    if (t) return cap(t, LABEL_CAP);
  }
  if (el.id) {
    const forLabel = [...doc.querySelectorAll('label[for]')].find(
      (l) => l.getAttribute('for') === el.id,
    );
    const t = forLabel ? labelText(forLabel as HTMLElement) : '';
    if (t) return cap(t, LABEL_CAP);
  }
  const wrapping = el.closest('label');
  if (wrapping) {
    const t = labelText(wrapping);
    if (t) return cap(t, LABEL_CAP);
  }
  // A label-ish element just before the control in the same small container.
  let container: HTMLElement | null = el.parentElement;
  for (let depth = 0; container && depth < 3; depth++, container = container.parentElement) {
    const candidate = [
      ...container.querySelectorAll('label, .label, [class*="label"], legend, .field-name, .title'),
    ].find(
      (c) =>
        !c.contains(el) &&
        !c.querySelector('input, select, textarea') &&
        (c.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ) as HTMLElement | undefined;
    if (candidate && text(candidate)) return cap(text(candidate), LABEL_CAP);
    if (container.querySelectorAll('input, select, textarea').length > 3) break;
  }
  const fallback =
    el.getAttribute('placeholder') ?? el.getAttribute('title') ?? el.getAttribute('name') ?? '';
  return cap(fallback.trim(), LABEL_CAP);
}

/** A control's label: aria-label, else its text, else title. */
export function controlLabel(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label')?.trim();
  const own = text(el);
  // An icon-only button ("›") is better named by its aria-label; a labelled one by its text.
  const pick = own && own.length > 1 && !/^[^\p{L}\p{N}]+$/u.test(own) ? own : aria || own;
  return cap((pick || el.getAttribute('title') || '').trim(), LABEL_CAP);
}

function controlKind(el: HTMLElement, label: string): ControlKind {
  if (el.matches('th, [role="columnheader"], .ag-header-cell')) return 'sort';
  if (el.getAttribute('role') === 'switch') return 'switch';
  if (
    el.closest('nav.pagination, .pagination, [aria-label*="pagination" i], [class*="pager"]') ||
    /^(next|previous|prev|first|last)( page)?$|^page \d+$/i.test(label)
  )
    return 'pagination';
  if (
    /\b(show|load|view|see) (more|all|less|fewer|older|newer)\b|^more$|^(older|newer)$/i.test(label)
  )
    return 'more';
  if (el.tagName === 'SUMMARY' || el.hasAttribute('aria-expanded')) return 'expander';
  if (el.tagName === 'A') return 'link';
  return 'button';
}

function controlState(el: HTMLElement, kind: ControlKind): string | undefined {
  if (kind === 'sort') return el.getAttribute('aria-sort') ?? undefined;
  if (kind === 'expander') {
    const exp =
      el.tagName === 'SUMMARY'
        ? (el.parentElement as HTMLDetailsElement | null)?.open
        : el.getAttribute('aria-expanded') === 'true';
    return exp ? 'expanded' : 'collapsed';
  }
  if (kind === 'switch') return el.getAttribute('aria-checked') === 'true' ? 'on' : 'off';
  if (kind === 'pagination' && (el.getAttribute('aria-current') || el.classList.contains('active')))
    return 'current';
  return undefined;
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────

function isFieldCandidate(el: FormEl): boolean {
  if (el instanceof HTMLInputElement) {
    return !['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image', 'color'].includes(
      el.type,
    );
  }
  if (el instanceof HTMLSelectElement) return !el.multiple;
  return true;
}

function isSensitive(el: FormEl): boolean {
  if (el instanceof HTMLInputElement && el.type === 'password') return true;
  const hay = [
    el.getAttribute('name'),
    el.id,
    el.getAttribute('autocomplete'),
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
    fieldLabelNoRecursion(el),
  ]
    .filter(Boolean)
    .join(' ');
  return SENSITIVE.test(hay);
}

/** The wrapping label's text — enough for the sensitivity check without the full label search. */
function fieldLabelNoRecursion(el: FormEl): string {
  const wrapping = el.closest('label');
  return wrapping ? labelText(wrapping) : '';
}

function labelText(label: HTMLElement): string {
  const clone = label.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('input, select, textarea, option').forEach((n) => n.remove());
  // `.sr-only` text IS a label (the data-table's search box) — keep it; drop only decoration.
  clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return text(clone);
}

function isDisabled(el: HTMLElement): boolean {
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute('aria-disabled') === 'true' ||
    !!el.closest('fieldset[disabled]')
  );
}

function radioGroup(el: HTMLInputElement): HTMLInputElement[] {
  if (!el.name) return [el];
  const scope = el.form ?? el.ownerDocument;
  return [...scope.querySelectorAll('input[type="radio"]')].filter(
    (r) => (r as HTMLInputElement).name === el.name,
  ) as HTMLInputElement[];
}

function radioGroupLabel(el: HTMLInputElement): string {
  const group = el.closest('[role="radiogroup"], fieldset');
  if (!group) return el.name || '';
  const aria = group.getAttribute('aria-label');
  if (aria) return cap(aria, LABEL_CAP);
  const legend = group.querySelector('legend');
  return legend ? text(legend) : el.name || '';
}

function optionLabelOfRadio(el: HTMLInputElement): string {
  return fieldLabel(el) || el.value;
}

function pickRadio(el: HTMLInputElement, raw: unknown): HTMLInputElement | null {
  const want = norm(String(raw ?? ''));
  const group = radioGroup(el);
  return (
    group.find((r) => norm(optionLabelOfRadio(r)) === want) ??
    group.find((r) => norm(r.value) === want) ??
    group.find((r) => norm(optionLabelOfRadio(r)).startsWith(want)) ??
    // `true` on a single radio means "select this one".
    (group.length === 1 && toBool(raw) === true ? group[0] : null)
  );
}

function pickOption(sel: HTMLSelectElement, raw: string): HTMLOptionElement | null {
  const want = norm(raw);
  const opts = [...sel.options].filter((o) => !o.disabled);
  return (
    opts.find((o) => norm(optionText(o)) === want) ??
    opts.find((o) => norm(o.value) === want) ??
    opts.find((o) => norm(optionText(o)).startsWith(want)) ??
    (want ? opts.find((o) => norm(optionText(o)).includes(want)) : undefined) ??
    null
  );
}

function optionText(o: HTMLOptionElement): string {
  return cap((o.label || o.text || o.value).replace(/\s+/g, ' ').trim(), LABEL_CAP);
}

function nativeSet(el: FormEl, value: string): void {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function finish(el: FormEl): SetOutcome {
  el.dispatchEvent(new FocusEvent('blur'));
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  return { ok: true, value: currentValue(el) };
}

function dateExample(el: HTMLInputElement): string {
  switch (el.type) {
    case 'datetime-local':
      return '2026-10-29T14:30';
    case 'month':
      return '2026-10';
    case 'week':
      return '2026-W44';
    case 'time':
      return '14:30';
    default:
      return '2026-10-29';
  }
}

function toBool(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (['true', 'on', 'yes', '1', 'checked'].includes(s)) return true;
  if (['false', 'off', 'no', '0', 'unchecked'].includes(s)) return false;
  return null;
}

function bodyRows(table: HTMLElement): HTMLElement[] {
  return ([...table.querySelectorAll(ROW_SELECTOR)] as HTMLElement[]).filter(
    (r) => !isHeaderRow(r) && visible(r),
  );
}

function isHeaderRow(r: HTMLElement): boolean {
  return (
    !!r.closest('thead, .ag-header') ||
    (r.getAttribute('role') === 'row' && !r.querySelector('[role="gridcell"], td'))
  );
}

function cells(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll('td, th, [role="gridcell"]')] as HTMLElement[];
}

function firstCellText(row: HTMLElement): string {
  const c = cells(row).find((x) => text(x));
  return c ? cap(text(c), 40) : '';
}

/** Whether clicking the row looks like it opens something. */
function rowOpens(row: HTMLElement, doc: Document): boolean {
  if (row.querySelector('a[href]')) return true;
  if (row.matches('[role="button"], [role="link"], [tabindex]') || row.hasAttribute('routerlink'))
    return true;
  if (
    row.classList.contains('clickable') ||
    row.matches('[class*="clickable"], [class*="row-link"]')
  )
    return true;
  if (hasLayout(doc)) {
    const target = row.querySelector('[role="gridcell"], td') ?? row;
    const cur = doc.defaultView?.getComputedStyle(target as HTMLElement).cursor;
    const rowCur = doc.defaultView?.getComputedStyle(row).cursor;
    return cur === 'pointer' || rowCur === 'pointer';
  }
  return false;
}

/** What to click to open a row: a non-action link in it, else its first plain cell. */
function rowClickElement(row: HTMLElement, doc: Document): HTMLElement {
  const link = ([...row.querySelectorAll('a[href]')] as HTMLElement[]).find(
    (a) => !clickRefusal(a, controlLabel(a) || 'link', doc),
  );
  if (link) return link;
  const plain = cells(row).find(
    (c) =>
      text(c) && !c.querySelector('button, input, select, textarea, a[href], [data-no-row-click]'),
  );
  return plain ?? row;
}

function tableHeading(el: HTMLElement): string | null {
  const aria = el.getAttribute('aria-label');
  if (aria) return cap(aria, LABEL_CAP);
  let node: HTMLElement | null = el;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    let sib = node.previousElementSibling as HTMLElement | null;
    while (sib) {
      const h = sib.matches('h1,h2,h3,h4,.section-title,.card-title')
        ? sib
        : (sib.querySelector('h1,h2,h3,h4,.section-title,.card-title') as HTMLElement | null);
      if (h && text(h)) return cap(text(h), LABEL_CAP);
      sib = sib.previousElementSibling as HTMLElement | null;
    }
  }
  return null;
}

function overlayWhere(el: HTMLElement): string {
  const label = el.getAttribute('aria-label');
  const heading = el.querySelector('h1, h2, h3, [class*="title"]');
  const name = label || text(heading);
  const kind = el.matches('[role="menu"], [role="listbox"]')
    ? 'menu'
    : el.matches('.drawer, [class*="drawer"]')
      ? 'drawer'
      : 'dialog';
  return name ? `${kind}: ${cap(name, 60)}` : kind;
}

/** The title of an overlay — what `page.click` reports when one opens. */
export function overlayTitle(el: HTMLElement): string {
  return overlayWhere(el);
}

/** Open overlays right now (for before/after comparison). */
export function openOverlays(doc: Document = document): HTMLElement[] {
  return ([...doc.querySelectorAll(OVERLAY_SELECTOR)] as HTMLElement[]).filter(
    (el) => visible(el) && !el.closest(DOCK_SELECTOR),
  );
}

function inAppHref(a: HTMLAnchorElement, doc: Document): string | null {
  try {
    const url = new URL(a.getAttribute('href') ?? '', doc.baseURI);
    return url.origin === new URL(doc.baseURI).origin ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

function hasLayout(doc: Document): boolean {
  return (doc.documentElement?.clientWidth ?? 0) > 0;
}

function visible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const doc = el.ownerDocument;
  if (hasLayout(doc)) {
    // A real browser: no boxes means not rendered (a display:none ancestor included).
    if (el.getClientRects().length === 0) return false;
    const style = doc.defaultView?.getComputedStyle(el);
    if (style && style.visibility === 'hidden') return false;
    return true;
  }
  // jsdom has no layout; only explicit styles count there.
  const style = doc.defaultView?.getComputedStyle(el);
  return !(style && (style.display === 'none' || style.visibility === 'hidden'));
}

function text(el: Element | null | undefined): string {
  if (!el) return '';
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? '';
  return raw.replace(/\s+/g, ' ').trim();
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

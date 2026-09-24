import type { AlertChannel } from '@core/api/api.types';

import {
  ALERT_KEY_ALERT_CALLS,
  ALERT_KEY_ORDER_FILLS,
  type ScriptAlertBinding,
  type ScriptCompileResult,
} from '../api/scripting-api.types';

/**
 * Alert bindings for script strategies (ADR-0027 §10): which of the script's alerts are
 * delivered, over which channels, with which message. Pure helpers — source scanning for
 * `alertcondition()` / `plot*()` titles, the Pine placeholder catalogue, template editing and
 * validation — so the tab component stays thin and every rule is unit-tested.
 */

export const ALERT_CHANNELS: readonly AlertChannel[] = ['Email', 'Webhook', 'Telegram'];

// ── Source scanning ───────────────────────────────────────────────────────────

export interface ScannedCall {
  /** The call's arguments as source text, top-level commas split. */
  args: string[];
  /** 1-based line of the call. */
  line: number;
  /** Character offset of the call's name. */
  offset: number;
}

interface Lexed {
  /** The source with comments blanked out (positions and line numbers unchanged). */
  text: string;
  /** [start, end) ranges of string literals, quotes included. */
  strings: [number, number][];
}

/**
 * Blanks out `//` comments while keeping string literals and every character position intact,
 * and records where the string literals are, so a call name inside a string (a comment text, an
 * alert message) is never mistaken for a call.
 */
function lex(source: string): Lexed {
  let text = '';
  const strings: [number, number][] = [];
  let i = 0;
  let quote: string | null = null;
  let start = 0;
  while (i < source.length) {
    const c = source[i];
    if (quote) {
      text += c;
      if (c === '\\' && i + 1 < source.length) {
        text += source[i + 1];
        i += 2;
        continue;
      }
      if (c === quote || c === '\n') {
        quote = null;
        strings.push([start, i + 1]);
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      start = i;
      text += c;
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        text += ' ';
        i++;
      }
      continue;
    }
    text += c;
    i++;
  }
  if (quote) strings.push([start, source.length]);
  return { text, strings };
}

function stripComments(source: string): string {
  return lex(source).text;
}

function insideString(offset: number, strings: readonly [number, number][]): boolean {
  return strings.some(([s, e]) => offset >= s && offset < e);
}

/** Every call of `name(...)` in the source (not `obj.name(...)`), with its raw arguments. */
export function scanCalls(source: string, name: string): ScannedCall[] {
  const { text, strings } = lex(source);
  const calls: ScannedCall[] = [];
  const re = new RegExp(`(^|[^\\w.])${name}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (insideString(m.index + m[1].length, strings)) continue;
    const open = m.index + m[0].length - 1;
    const args: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let current = '';
    let i = open;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        current += c;
        if (c === '\\' && i + 1 < text.length) {
          current += text[++i];
          continue;
        }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        current += c;
        continue;
      }
      if (c === '(' || c === '[') {
        depth++;
        if (depth === 1 && c === '(') continue;
        current += c;
        continue;
      }
      if (c === ')' || c === ']') {
        depth--;
        if (depth === 0) break;
        current += c;
        continue;
      }
      if (c === ',' && depth === 1) {
        args.push(current.trim());
        current = '';
        continue;
      }
      current += c;
    }
    if (current.trim() !== '') args.push(current.trim());
    const offset = m.index + m[1].length;
    const line = text.slice(0, offset).split('\n').length;
    calls.push({ args, line, offset });
    re.lastIndex = i;
  }
  return calls;
}

/** The value of a string literal argument (`"x"` / `'x'`), or null for anything else. */
export function stringLiteral(arg: string | undefined): string | null {
  if (!arg) return null;
  const m = /^(["'])((?:\\.|(?!\1)[^\\])*)\1$/.exec(arg.trim());
  if (!m) return null;
  return m[2].replace(/\\(["'\\nt])/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === 't' ? '\t' : ch,
  );
}

/** Reads a call argument by name (`title=…`) or, failing that, by position. */
function argument(call: ScannedCall, name: string, position: number): string | undefined {
  const named = call.args.find((a) => new RegExp(`^${name}\\s*=(?!=)`).test(a));
  if (named) return named.replace(new RegExp(`^${name}\\s*=`), '').trim();
  const positional = call.args.filter((a) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(a));
  return positional[position];
}

export interface AlertConditionInfo {
  title: string;
  message: string | null;
  line: number;
}

export interface AlertConditionScan {
  conditions: AlertConditionInfo[];
  /** alertcondition() calls whose title is not a constant string (cannot be bound by title). */
  untitled: number;
}

/** `alertcondition(condition, title, message)` titles and default messages, in source order. */
export function extractAlertConditions(source: string | null | undefined): AlertConditionScan {
  if (!source) return { conditions: [], untitled: 0 };
  const seen = new Set<string>();
  const conditions: AlertConditionInfo[] = [];
  let untitled = 0;
  for (const call of scanCalls(source, 'alertcondition')) {
    const title = stringLiteral(argument(call, 'title', 1));
    if (!title) {
      untitled++;
      continue;
    }
    if (seen.has(title)) continue;
    seen.add(title);
    conditions.push({
      title,
      message: stringLiteral(argument(call, 'message', 2)),
      line: call.line,
    });
  }
  return { conditions, untitled };
}

/** Where the `title` sits positionally in each plot function. */
const PLOT_FUNCTIONS: readonly [string, number][] = [
  ['plot', 1],
  ['plotshape', 1],
  ['plotchar', 1],
  ['plotarrow', 1],
  ['plotcandle', 4],
  ['plotbar', 4],
];

export interface PlotInfo {
  /** Index as `{{plot_N}}` counts it: plots in source order. */
  index: number;
  title: string | null;
}

/** The script's plots in source order, with their constant titles where they have one. */
export function extractPlots(source: string | null | undefined): PlotInfo[] {
  if (!source) return [];
  const found: { offset: number; title: string | null }[] = [];
  for (const [fn, titlePos] of PLOT_FUNCTIONS) {
    for (const call of scanCalls(source, fn)) {
      found.push({ offset: call.offset, title: stringLiteral(argument(call, 'title', titlePos)) });
    }
  }
  return found.sort((a, b) => a.offset - b.offset).map((p, index) => ({ index, title: p.title }));
}

/** indicator / strategy / library, from the compile result, else the source's declaration. */
export function scriptKind(
  compile: ScriptCompileResult | null,
  source: string | null | undefined,
): 'strategy' | 'indicator' | 'library' | 'unknown' {
  const k = compile?.declaration?.kind?.toString().toLowerCase();
  if (k === 'strategy' || k === 'indicator' || k === 'library') return k;
  const text = stripComments(source ?? '');
  if (/(^|[^\w.])strategy\s*\(/.test(text)) return 'strategy';
  if (/(^|[^\w.])indicator\s*\(/.test(text) || /(^|[^\w.])study\s*\(/.test(text))
    return 'indicator';
  if (/(^|[^\w.])library\s*\(/.test(text)) return 'library';
  return 'unknown';
}

// ── Placeholders ──────────────────────────────────────────────────────────────

export interface Placeholder {
  token: string;
  label: string;
}

export interface PlaceholderGroup {
  label: string;
  items: Placeholder[];
}

export const GENERAL_PLACEHOLDERS: readonly Placeholder[] = [
  { token: '{{ticker}}', label: 'Symbol (ticker)' },
  { token: '{{exchange}}', label: 'Exchange' },
  { token: '{{interval}}', label: 'Timeframe' },
  { token: '{{open}}', label: 'Bar open' },
  { token: '{{high}}', label: 'Bar high' },
  { token: '{{low}}', label: 'Bar low' },
  { token: '{{close}}', label: 'Bar close' },
  { token: '{{volume}}', label: 'Bar volume' },
  { token: '{{time}}', label: 'Bar time (UTC)' },
  { token: '{{timenow}}', label: 'Alert time (UTC)' },
  { token: '{{syminfo.currency}}', label: 'Quote currency' },
  { token: '{{syminfo.basecurrency}}', label: 'Base currency' },
];

export const ORDER_FILL_PLACEHOLDERS: readonly Placeholder[] = [
  { token: '{{strategy.order.action}}', label: 'Order action (buy / sell)' },
  { token: '{{strategy.order.contracts}}', label: 'Order size' },
  { token: '{{strategy.order.price}}', label: 'Fill price' },
  { token: '{{strategy.order.id}}', label: 'Order id' },
  { token: '{{strategy.order.comment}}', label: 'Order comment' },
  { token: '{{strategy.order.alert_message}}', label: 'Order alert_message' },
  { token: '{{strategy.market_position}}', label: 'Position (long / short / flat)' },
  { token: '{{strategy.market_position_size}}', label: 'Position size' },
  { token: '{{strategy.prev_market_position}}', label: 'Previous position' },
  { token: '{{strategy.prev_market_position_size}}', label: 'Previous position size' },
  { token: '{{strategy.position_size}}', label: 'Signed position size' },
];

/** Plot placeholders for a script: `{{plot_N}}` by index and `{{plot("Title")}}` by title. */
export function plotPlaceholders(plots: readonly PlotInfo[]): Placeholder[] {
  const out: Placeholder[] = [];
  for (const p of plots) {
    out.push({
      token: `{{plot_${p.index}}}`,
      label: `Plot ${p.index}${p.title ? ` — ${p.title}` : ''}`,
    });
  }
  for (const p of plots) {
    if (p.title) out.push({ token: `{{plot("${p.title}")}}`, label: `Plot "${p.title}"` });
  }
  return out;
}

export type AlertRowKind = 'condition' | 'alert-calls' | 'order-fills';

export function rowKindOf(alertKey: string): AlertRowKind {
  if (alertKey === ALERT_KEY_ORDER_FILLS) return 'order-fills';
  if (alertKey === ALERT_KEY_ALERT_CALLS) return 'alert-calls';
  return 'condition';
}

/** The placeholders offered for a row: order fills get the strategy.* set, others the plots. */
export function placeholderGroupsFor(
  kind: AlertRowKind,
  plots: readonly PlotInfo[],
): PlaceholderGroup[] {
  const groups: PlaceholderGroup[] = [
    { label: 'Symbol and bar', items: [...GENERAL_PLACEHOLDERS] },
  ];
  const plotItems = plotPlaceholders(plots);
  if (plotItems.length > 0) groups.push({ label: 'Plots', items: plotItems });
  if (kind === 'order-fills')
    groups.push({ label: 'Order fill', items: [...ORDER_FILL_PLACEHOLDERS] });
  return groups;
}

/**
 * `{{…}}` tokens in a template that the row does not offer — almost always typos, which would
 * otherwise go out as literal braces. Plot references are checked only when the plots are known.
 */
export function unknownPlaceholders(
  template: string | null | undefined,
  groups: readonly PlaceholderGroup[],
  plotsKnown: boolean,
): string[] {
  if (!template) return [];
  const allowed = new Set(groups.flatMap((g) => g.items.map((i) => i.token)));
  const unknown: string[] = [];
  for (const m of template.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const token = `{{${m[1]}}}`;
    if (allowed.has(token)) continue;
    if (!plotsKnown && /^plot(_\d+|\(\s*"[^"]*"\s*\))$/.test(m[1])) continue;
    if (!unknown.includes(token)) unknown.push(token);
  }
  return unknown;
}

/** Inserts `token` over the selection; returns the new text and where the caret goes. */
export function insertAt(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  token: string,
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  return { text: text.slice(0, start) + token + text.slice(end), caret: start + token.length };
}

// ── Validation ────────────────────────────────────────────────────────────────

export const MAX_TEMPLATE_LENGTH = 4000;

export interface UrlCheck {
  error: string | null;
  warning: string | null;
}

/** A webhook must be an absolute http(s) URL with a host; plain http is allowed but flagged. */
export function checkWebhookUrl(url: string | null | undefined): UrlCheck {
  const value = (url ?? '').trim();
  if (!value) return { error: 'A webhook URL is required for the Webhook channel.', warning: null };
  if (/\s/.test(value)) return { error: 'The URL cannot contain spaces.', warning: null };
  if (value.length > 2048)
    return { error: 'The URL is longer than 2048 characters.', warning: null };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: 'Enter a full URL, e.g. https://example.com/hook.', warning: null };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'Only http:// and https:// webhooks are supported.', warning: null };
  }
  if (!parsed.hostname) return { error: 'The URL has no host.', warning: null };
  if (parsed.username || parsed.password) {
    return {
      error: 'Do not put credentials in the URL; the message travels to that host.',
      warning: null,
    };
  }
  return {
    error: null,
    warning:
      parsed.protocol === 'http:' ? 'Plain http sends the alert unencrypted. Prefer https.' : null,
  };
}

export interface AlertRow extends ScriptAlertBinding {
  kind: AlertRowKind;
  /** alertcondition's own message (the default when no template is set). */
  defaultMessage: string | null;
  /** Saved binding whose alert is no longer in the script. */
  orphan: boolean;
}

export interface RowIssues {
  errors: string[];
  warnings: string[];
}

export function validateRow(
  row: AlertRow,
  groups: readonly PlaceholderGroup[],
  plotsKnown: boolean,
): RowIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (row.enabled && row.channels.length === 0) errors.push('Choose at least one channel.');
  if (row.channels.includes('Webhook')) {
    const url = checkWebhookUrl(row.webhookUrl);
    if (url.error) errors.push(url.error);
    if (url.warning) warnings.push(url.warning);
  }
  if ((row.messageTemplate ?? '').length > MAX_TEMPLATE_LENGTH) {
    errors.push(`The message is longer than ${MAX_TEMPLATE_LENGTH} characters.`);
  }
  const unknown = unknownPlaceholders(row.messageTemplate, groups, plotsKnown);
  if (unknown.length > 0) warnings.push(`Not a placeholder here: ${unknown.join(', ')}.`);
  return { errors, warnings };
}

// ── Rows ──────────────────────────────────────────────────────────────────────

function blank(alertKey: string, kind: AlertRowKind, defaultMessage: string | null): AlertRow {
  return {
    alertKey,
    enabled: false,
    channels: [],
    messageTemplate: null,
    webhookUrl: null,
    kind,
    defaultMessage,
    orphan: false,
  };
}

function fromSaved(
  b: ScriptAlertBinding,
  kind: AlertRowKind,
  defaultMessage: string | null,
  orphan: boolean,
): AlertRow {
  return {
    alertKey: b.alertKey,
    enabled: b.enabled === true,
    channels: (b.channels ?? []).filter((c): c is AlertChannel => ALERT_CHANNELS.includes(c)),
    messageTemplate: b.messageTemplate ?? null,
    webhookUrl: b.webhookUrl ?? null,
    kind,
    defaultMessage,
    orphan,
  };
}

/**
 * One row per alertcondition title (source order), then "alert() calls", then "Order fills"
 * (strategies only), each carrying its saved binding when there is one. Saved bindings whose alert
 * left the script are kept at the end, flagged, so nothing is dropped silently.
 */
export function buildAlertRows(
  saved: readonly ScriptAlertBinding[],
  conditions: readonly AlertConditionInfo[],
  isStrategy: boolean,
): AlertRow[] {
  const byKey = new Map(saved.map((b) => [b.alertKey, b]));
  const rows: AlertRow[] = [];
  const used = new Set<string>();
  for (const c of conditions) {
    const s = byKey.get(c.title);
    rows.push(
      s ? fromSaved(s, 'condition', c.message, false) : blank(c.title, 'condition', c.message),
    );
    used.add(c.title);
  }
  const fixed: [string, AlertRowKind, boolean][] = [
    [ALERT_KEY_ALERT_CALLS, 'alert-calls', true],
    [ALERT_KEY_ORDER_FILLS, 'order-fills', isStrategy],
  ];
  for (const [key, kind, include] of fixed) {
    const s = byKey.get(key);
    if (!include && !s) continue;
    rows.push(s ? fromSaved(s, kind, null, !include) : blank(key, kind, null));
    used.add(key);
  }
  for (const b of saved) {
    if (!used.has(b.alertKey)) rows.push(fromSaved(b, rowKindOf(b.alertKey), null, true));
  }
  return rows;
}

/** The PUT body: every row, as the contract's binding shape (empty strings sent as null). */
export function toAlertBindings(rows: readonly AlertRow[]): ScriptAlertBinding[] {
  return rows.map((r) => ({
    alertKey: r.alertKey,
    enabled: r.enabled,
    channels: [...r.channels],
    messageTemplate: r.messageTemplate?.trim() ? r.messageTemplate : null,
    webhookUrl: r.channels.includes('Webhook') && r.webhookUrl?.trim() ? r.webhookUrl.trim() : null,
  }));
}

/** Rows whose sent shape differs (the save button's dirty state). */
export function alertRowsDiffer(a: readonly AlertRow[], b: readonly AlertRow[]): boolean {
  return JSON.stringify(toAlertBindings(a)) !== JSON.stringify(toAlertBindings(b));
}

export function rowTitle(row: AlertRow): string {
  switch (row.kind) {
    case 'alert-calls':
      return 'alert() calls';
    case 'order-fills':
      return 'Order fills';
    default:
      return row.alertKey;
  }
}

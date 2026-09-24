import type {
  ScriptInputDto,
  ScriptInputValue,
  ScriptInputValues,
} from '@core/api/scripting.types';
import { PINE_SOURCES } from './pine-lexicon';

/**
 * Pure helpers behind the inputs form: default values, coercion of widget values into the §9 wire
 * shape, override maps, the Pine "Settings/Inputs" layout (groups and inline rows), and the
 * color / session / time / timeframe conversions the widgets need.
 */

// ── Timeframes ─────────────────────────────────────────────────────────────

export interface TimeframeOption {
  value: string;
  label: string;
}

/** Pine timeframe strings offered by `input.timeframe` (the chart's "Time interval" menu). */
export const PINE_TIMEFRAME_OPTIONS: readonly TimeframeOption[] = [
  { value: '', label: 'Chart' },
  { value: '1S', label: '1 second' },
  { value: '5S', label: '5 seconds' },
  { value: '15S', label: '15 seconds' },
  { value: '30S', label: '30 seconds' },
  { value: '1', label: '1 minute' },
  { value: '3', label: '3 minutes' },
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '45', label: '45 minutes' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
  { value: '180', label: '3 hours' },
  { value: '240', label: '4 hours' },
  { value: '1D', label: '1 day' },
  { value: '1W', label: '1 week' },
  { value: '1M', label: '1 month' },
  { value: '3M', label: '3 months' },
  { value: '12M', label: '12 months' },
];

/** Human label for a Pine timeframe string (`60` → `1 hour`, `D` → `1 day`). */
export function timeframeLabel(tf: string): string {
  const v = normaliseTimeframe(tf);
  const known = PINE_TIMEFRAME_OPTIONS.find((o) => o.value === v);
  if (known) return known.label;
  const m = /^(\d+)([SDWMT]?)$/.exec(v);
  if (!m) return tf;
  const n = Number(m[1]);
  const unit = m[2];
  const plural = (s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;
  switch (unit) {
    case 'S':
      return plural('second');
    case 'D':
      return plural('day');
    case 'W':
      return plural('week');
    case 'M':
      return plural('month');
    case 'T':
      return plural('tick');
    default: {
      if (n % 60 !== 0) return plural('minute');
      const h = n / 60;
      return `${h} hour${h === 1 ? '' : 's'}`;
    }
  }
}

/** `D` → `1D`, `W` → `1W`, `M` → `1M`; everything else unchanged. */
export function normaliseTimeframe(tf: string): string {
  const t = (tf ?? '').trim().toUpperCase();
  return t === 'D' || t === 'W' || t === 'M' ? `1${t}` : t;
}

const ENGINE_TIMEFRAMES: Record<string, string> = {
  M1: '1',
  M5: '5',
  M15: '15',
  M30: '30',
  H1: '60',
  H4: '240',
  D1: '1D',
  W1: '1W',
};

/** The engine's `M1`…`D1` as the Pine timeframe string. */
export function engineToPineTimeframe(tf: string | null | undefined): string {
  if (!tf) return '';
  return ENGINE_TIMEFRAMES[tf.toUpperCase()] ?? normaliseTimeframe(tf);
}

// ── Colors ─────────────────────────────────────────────────────────────────

export interface ColorParts {
  /** `#RRGGBB`, upper case. */
  hex: string;
  /** 0 (transparent) … 255 (opaque). */
  alpha: number;
}

/** Reads `#RGB`, `#RRGGBB` or `#RRGGBBAA`; null for anything else. */
export function parseColor(value: unknown): ColorParts | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  let m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(v);
  if (m) {
    return { hex: `#${m[1].toUpperCase()}`, alpha: m[2] ? parseInt(m[2], 16) : 255 };
  }
  m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(v);
  if (m) {
    return { hex: `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toUpperCase(), alpha: 255 };
  }
  return null;
}

/** `#RRGGBBAA` — the wire form of a color input. */
export function formatColor(parts: ColorParts): string {
  const a = Math.max(0, Math.min(255, Math.round(parts.alpha)));
  return `${parts.hex.toUpperCase()}${a.toString(16).padStart(2, '0').toUpperCase()}`;
}

/** Opacity as a 0–100 percentage (TradingView's color picker shows opacity). */
export function alphaToOpacity(alpha: number): number {
  return Math.round((alpha / 255) * 100);
}

export function opacityToAlpha(opacity: number): number {
  return Math.round((Math.max(0, Math.min(100, opacity)) / 100) * 255);
}

/** CSS `rgba()` for a `#RRGGBBAA` value — swatches render it over a checkerboard. */
export function colorToCss(value: unknown): string {
  const p = parseColor(value);
  if (!p) return 'transparent';
  const r = parseInt(p.hex.slice(1, 3), 16);
  const g = parseInt(p.hex.slice(3, 5), 16);
  const b = parseInt(p.hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${+(p.alpha / 255).toFixed(3)})`;
}

// ── Sessions ───────────────────────────────────────────────────────────────

export interface SessionParts {
  /** `HH:mm` */
  start: string;
  /** `HH:mm` */
  end: string;
  /** Pine day digits `1234567` (1 = Sunday), or null for "every day". */
  days: string | null;
}

/** Reads a Pine session string `0930-1600[:23456]`; `24x7` is the whole day. */
export function parseSession(value: unknown): SessionParts {
  const v = typeof value === 'string' ? value.trim() : '';
  if (/^24x7$/i.test(v)) return { start: '00:00', end: '00:00', days: null };
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})(?::([1-7]+))?/.exec(v);
  if (!m) return { start: '00:00', end: '00:00', days: null };
  return { start: `${m[1]}:${m[2]}`, end: `${m[3]}:${m[4]}`, days: m[5] ?? null };
}

export function formatSession(parts: SessionParts): string {
  const hhmm = (t: string) => (/^\d{2}:\d{2}$/.test(t) ? t.replace(':', '') : '0000');
  const days = parts.days ? `:${[...new Set(parts.days.split(''))].sort().join('')}` : '';
  return `${hhmm(parts.start)}-${hhmm(parts.end)}${days}`;
}

/** Pine day digits: 1 = Sunday … 7 = Saturday. */
export const SESSION_DAYS: readonly { digit: string; label: string }[] = [
  { digit: '2', label: 'Mo' },
  { digit: '3', label: 'Tu' },
  { digit: '4', label: 'We' },
  { digit: '5', label: 'Th' },
  { digit: '6', label: 'Fr' },
  { digit: '7', label: 'Sa' },
  { digit: '1', label: 'Su' },
];

// ── Time ───────────────────────────────────────────────────────────────────

/** Unix ms → `YYYY-MM-DDTHH:mm` in UTC, for a `datetime-local` widget labelled UTC. */
export function msToUtcInput(ms: unknown): string {
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}`;
}

/** `YYYY-MM-DDTHH:mm` (read as UTC) → Unix ms; NaN when unparseable. */
export function utcInputToMs(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value ?? '');
  if (!m) return Number.NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

// ── Values ─────────────────────────────────────────────────────────────────

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function clamp(n: number, input: ScriptInputDto): number {
  let v = n;
  if (input.minValue !== null && input.minValue !== undefined) v = Math.max(input.minValue, v);
  if (input.maxValue !== null && input.maxValue !== undefined) v = Math.min(input.maxValue, v);
  return v;
}

/** An enum value as its member name (`SignalType.long` → `long`). */
function enumMember(v: unknown): string {
  const s = String(v ?? '');
  const dot = s.lastIndexOf('.');
  return dot >= 0 ? s.slice(dot + 1) : s;
}

/**
 * The input's default in wire form. The engine sends `defaultValue` as JSON plus `defaultText` as
 * written; where the two disagree in type (a source's default, a color packed as a number) the
 * text wins.
 */
export function inputDefault(input: ScriptInputDto): ScriptInputValue {
  const dv = input.defaultValue;
  const text = input.defaultText ?? null;
  switch (input.kind) {
    case 'int': {
      const n = asNumber(dv) ?? asNumber(text) ?? 0;
      return Math.round(n);
    }
    case 'float':
    case 'price':
      return asNumber(dv) ?? asNumber(text) ?? 0;
    case 'time':
      return asNumber(dv) ?? asNumber(text) ?? 0;
    case 'bool':
      return typeof dv === 'boolean' ? dv : String(text ?? dv).toLowerCase() === 'true';
    case 'color': {
      const p = parseColor(dv) ?? parseColor(text);
      return p ? formatColor(p) : '#000000FF';
    }
    case 'source': {
      const s = typeof dv === 'string' && dv ? dv : (text ?? 'close');
      return PINE_SOURCES.includes(s) ? s : s || 'close';
    }
    case 'enum':
      return enumMember(typeof dv === 'string' && dv ? dv : text);
    case 'timeframe':
      return normaliseTimeframe(typeof dv === 'string' ? dv : (text ?? ''));
    default:
      return typeof dv === 'string' ? dv : (text ?? (dv === null ? '' : String(dv)));
  }
}

/**
 * Coerces a widget's raw value into the input's wire value — numbers rounded and clamped, colors
 * as `#RRGGBBAA`, enum members by name. Anything unusable falls back to the default.
 */
export function coerceInputValue(input: ScriptInputDto, raw: unknown): ScriptInputValue {
  const fallback = inputDefault(input);
  switch (input.kind) {
    case 'int': {
      const n = asNumber(raw);
      return n === null ? fallback : clamp(Math.round(n), input);
    }
    case 'float':
    case 'price': {
      const n = asNumber(raw);
      return n === null ? fallback : clamp(n, input);
    }
    case 'time': {
      if (typeof raw === 'string' && raw.includes('T')) {
        const ms = utcInputToMs(raw);
        return Number.isFinite(ms) ? ms : fallback;
      }
      const n = asNumber(raw);
      return n === null ? fallback : Math.round(n);
    }
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      return fallback;
    case 'color': {
      const p = parseColor(raw);
      return p ? formatColor(p) : fallback;
    }
    case 'source': {
      const s = String(raw ?? '');
      const allowed = optionValues(input) ?? PINE_SOURCES;
      return allowed.map(String).includes(s) ? s : fallback;
    }
    case 'enum': {
      const member = enumMember(raw);
      const allowed = optionValues(input);
      return !allowed || allowed.map((o) => enumMember(o)).includes(member) ? member : fallback;
    }
    case 'timeframe':
      return normaliseTimeframe(String(raw ?? ''));
    case 'session':
      return typeof raw === 'string' && raw ? raw : fallback;
    default:
      return raw === null || raw === undefined ? fallback : String(raw);
  }
}

function optionValues(input: ScriptInputDto): ScriptInputValue[] | null {
  return Array.isArray(input.options) && input.options.length > 0 ? input.options : null;
}

/** `{ label, value }` pairs for a dropdown — option titles when the engine sent them. */
export function inputOptions(input: ScriptInputDto): { value: string; label: string }[] {
  const opts = optionValues(input);
  if (input.kind === 'source' && !opts) {
    return PINE_SOURCES.map((s) => ({ value: s, label: s }));
  }
  if (input.kind === 'timeframe') {
    const list = opts
      ? opts.map((o) => {
          const v = normaliseTimeframe(String(o));
          return { value: v, label: timeframeLabel(v) || 'Chart' };
        })
      : PINE_TIMEFRAME_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
    return list;
  }
  if (!opts) return [];
  return opts.map((o, i) => {
    const value = input.kind === 'enum' ? enumMember(o) : String(o);
    const label = input.optionTexts?.[i] ?? value;
    return { value, label };
  });
}

function sameValue(a: ScriptInputValue | undefined, b: ScriptInputValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (typeof a === 'string' && typeof b === 'string') return a.toUpperCase() === b.toUpperCase();
  return a === b;
}

/**
 * Every input's current value: a saved override when it still applies (coerced — the script may
 * have tightened a range since), otherwise the default.
 */
export function resolveInputValues(
  inputs: readonly ScriptInputDto[],
  saved: ScriptInputValues | null | undefined,
): ScriptInputValues {
  const out: ScriptInputValues = {};
  for (const input of inputs) {
    const has = saved && Object.prototype.hasOwnProperty.call(saved, input.id);
    out[input.id] = has ? coerceInputValue(input, saved![input.id]) : inputDefault(input);
  }
  return out;
}

/** Only the values that differ from the defaults — what a strategy stores as `scriptInputs`. */
export function inputOverrides(
  inputs: readonly ScriptInputDto[],
  values: ScriptInputValues,
): ScriptInputValues {
  const out: ScriptInputValues = {};
  for (const input of inputs) {
    if (!Object.prototype.hasOwnProperty.call(values, input.id)) continue;
    const v = values[input.id];
    if (!sameValue(v, inputDefault(input))) out[input.id] = v;
  }
  return out;
}

/** False when the input's `active` bool input is switched off — the widget is greyed out. */
export function isInputActive(input: ScriptInputDto, values: ScriptInputValues): boolean {
  const gate = input.activeWhenInputId;
  if (!gate) return true;
  if (!Object.prototype.hasOwnProperty.call(values, gate)) return true;
  return values[gate] === true;
}

/** Parses a strategy's `scriptInputs`, which older engines may send as JSON text. */
export function parseSavedInputs(raw: unknown): ScriptInputValues {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? (raw as ScriptInputValues) : {};
}

// ── Layout ─────────────────────────────────────────────────────────────────

export interface InputRow {
  /** The `inline` id; null for an input on its own line. */
  inline: string | null;
  inputs: ScriptInputDto[];
  /** The line's tooltip: the LAST tooltip given on the line, shown right of the rightmost field. */
  tooltip: string | null;
}

export interface InputSection {
  /** The `group` heading; null for ungrouped inputs. */
  group: string | null;
  rows: InputRow[];
}

/**
 * Lays inputs out the way Pine's "Settings/Inputs" tab does: in call order, inputs sharing a
 * `group` collected under one heading (placed where the group first appears), inputs sharing an
 * `inline` id on one line within their section. Consecutive ungrouped inputs share a section.
 */
export function layoutInputs(inputs: readonly ScriptInputDto[]): InputSection[] {
  const sections: InputSection[] = [];
  const byGroup = new Map<string, InputSection>();
  let openUngrouped: InputSection | null = null;
  for (const input of inputs) {
    const group = input.group?.trim() ? input.group : null;
    let section: InputSection;
    if (group !== null) {
      const existing = byGroup.get(group);
      if (existing) section = existing;
      else {
        section = { group, rows: [] };
        byGroup.set(group, section);
        sections.push(section);
      }
      openUngrouped = null;
    } else {
      if (!openUngrouped) {
        openUngrouped = { group: null, rows: [] };
        sections.push(openUngrouped);
      }
      section = openUngrouped;
    }
    const inline = input.inline?.length ? input.inline : null;
    const row = inline !== null ? section.rows.find((r) => r.inline === inline) : undefined;
    if (row) {
      row.inputs.push(input);
      if (input.tooltip) row.tooltip = input.tooltip;
    } else {
      section.rows.push({ inline, inputs: [input], tooltip: input.tooltip ?? null });
    }
  }
  return sections;
}

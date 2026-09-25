import type { ScriptInputDef } from '../api/scripting-api.types';

/**
 * Script `input.*()` overrides (§9 InputDto): which control edits each input, how text becomes a
 * wire value (numbers, booleans, strings; colours as `#RRGGBBAA`; time in ms; source as the series
 * name; enum as the member name) and which values actually differ from the baseline.
 */

export type InputControl =
  | 'integer'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'text'
  | 'textarea'
  | 'datetime';

export interface InputOption {
  /** The wire value, JSON-encoded so a select can carry numbers and strings alike. */
  key: string;
  label: string;
}

export interface InputField {
  def: ScriptInputDef;
  kind: string;
  control: InputControl;
  options: InputOption[];
}

export const SOURCE_SERIES = [
  'open',
  'high',
  'low',
  'close',
  'hl2',
  'hlc3',
  'ohlc4',
  'hlcc4',
  'volume',
];

/** `Int` / `int` / `INT` → `int`; `TextArea` → `textArea`. */
export function normalizeInputKind(kind: string | null | undefined): string {
  if (!kind) return 'string';
  const k = kind.trim();
  return k.charAt(0).toLowerCase() + k.slice(1);
}

export function fieldFor(def: ScriptInputDef): InputField {
  const kind = normalizeInputKind(def.kind);
  const options: InputOption[] = [];
  if (def.options && def.options.length > 0) {
    def.options.forEach((o, i) => {
      options.push({ key: JSON.stringify(o), label: def.optionTexts?.[i] ?? String(o) });
    });
    return { def, kind, control: 'select', options };
  }
  if (kind === 'source') {
    const current =
      typeof def.defaultValue === 'string' ? def.defaultValue : (def.defaultText ?? 'close');
    const series = SOURCE_SERIES.includes(current) ? SOURCE_SERIES : [current, ...SOURCE_SERIES];
    return {
      def,
      kind,
      control: 'select',
      options: series.map((s) => ({ key: JSON.stringify(s), label: s })),
    };
  }
  switch (kind) {
    case 'int':
      return { def, kind, control: 'integer', options };
    case 'float':
    case 'price':
      return { def, kind, control: 'number', options };
    case 'bool':
      return { def, kind, control: 'checkbox', options };
    case 'textArea':
      return { def, kind, control: 'textarea', options };
    case 'time':
      return { def, kind, control: 'datetime', options };
    default:
      return { def, kind, control: 'text', options };
  }
}

/** The value in effect: the strategy's saved override, else the script's default. */
export function effectiveValue(
  def: ScriptInputDef,
  saved: Readonly<Record<string, unknown>>,
): unknown {
  return Object.prototype.hasOwnProperty.call(saved, def.id) ? saved[def.id] : def.defaultValue;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Text shown in a control for a value. */
export function displayValue(field: InputField, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (field.control === 'select') return JSON.stringify(value);
  if (field.control === 'datetime' && typeof value === 'number') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  return typeof value === 'string' ? value : String(value);
}

export interface ParsedInput {
  value: unknown;
  error: string | null;
}

/** Turns a control's raw value into the wire value, with the input's own bounds enforced. */
export function parseInputValue(field: InputField, raw: string | boolean): ParsedInput {
  const def = field.def;
  if (field.control === 'checkbox') return { value: raw === true || raw === 'true', error: null };
  const text = typeof raw === 'string' ? raw : String(raw);
  switch (field.control) {
    case 'select': {
      try {
        return { value: JSON.parse(text), error: null };
      } catch {
        return { value: text, error: null };
      }
    }
    case 'integer':
    case 'number': {
      if (text.trim() === '') return { value: null, error: 'Enter a number.' };
      const n = Number(text);
      if (!Number.isFinite(n)) return { value: null, error: 'Enter a number.' };
      if (field.control === 'integer' && !Number.isInteger(n)) {
        return { value: null, error: 'Enter a whole number.' };
      }
      if (def.minValue != null && n < def.minValue) {
        return { value: n, error: `Must be at least ${def.minValue}.` };
      }
      if (def.maxValue != null && n > def.maxValue) {
        return { value: n, error: `Must be at most ${def.maxValue}.` };
      }
      return { value: n, error: null };
    }
    case 'datetime': {
      if (text.trim() === '') return { value: null, error: 'Enter a date and time.' };
      // A datetime-local value ("2026-01-05T08:00") is read as UTC, like every time in the report.
      const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text.trim()) ? `${text.trim()}:00Z` : text;
      const parsed = Date.parse(iso);
      return Number.isFinite(parsed)
        ? { value: parsed, error: null }
        : { value: null, error: 'Enter a valid date and time.' };
    }
    default: {
      if (
        field.kind === 'color' &&
        text.trim() !== '' &&
        !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(text.trim())
      ) {
        return { value: text, error: 'Use #RRGGBB or #RRGGBBAA.' };
      }
      return { value: field.kind === 'color' ? text.trim() : text, error: null };
    }
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The inputs whose value differs from the baseline — what an override actually needs to send. */
export function diffOverrides(
  baseline: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(current)) {
    if (!sameValue(v, baseline[k])) out[k] = v;
  }
  return out;
}

export interface FieldGroup {
  title: string | null;
  fields: InputField[];
}

/** Inputs in declaration order, grouped by their `group=` (ungrouped inputs first). */
export function groupFields(fields: readonly InputField[]): FieldGroup[] {
  const groups: FieldGroup[] = [];
  const byTitle = new Map<string | null, FieldGroup>();
  for (const f of fields) {
    const title = f.def.group?.trim() || null;
    let g = byTitle.get(title);
    if (!g) {
      g = { title, fields: [] };
      byTitle.set(title, g);
      if (title === null) groups.unshift(g);
      else groups.push(g);
    }
    g.fields.push(f);
  }
  return groups;
}

/** An input disabled by its `active=` bool input being off. */
export function isInactive(
  def: ScriptInputDef,
  values: Readonly<Record<string, unknown>>,
): boolean {
  return !!def.activeWhenInputId && values[def.activeWhenInputId] === false;
}

/**
 * Free-form value for the key/value editor used when the inputs schema is unavailable: JSON
 * literals (numbers, booleans, quoted strings, null) as such, anything else as a plain string.
 */
export function parseLooseValue(text: string): unknown {
  const t = text.trim();
  if (t === '') return '';
  if (
    /^(true|false|null)$/.test(t) ||
    /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t) ||
    /^".*"$/.test(t)
  ) {
    try {
      return JSON.parse(t);
    } catch {
      return text;
    }
  }
  return text;
}

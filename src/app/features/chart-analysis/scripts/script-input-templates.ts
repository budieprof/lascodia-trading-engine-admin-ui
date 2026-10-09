import type { ScriptInputValues } from '@core/api/scripting.types';

/**
 * Named input templates for the chart's Pine scripts (PC-I12) — TradingView's "Save as…" under a
 * study's Defaults: the operator names a set of inputs and applies it again later, on any chart.
 * Kept in the chart preferences the engine syncs across browsers (`ChartPrefsService`, a
 * `SYNCED_PREF_KEYS` entry), by the script they belong to.
 */
export const SCRIPT_INPUT_TEMPLATES_KEY = 'lascodia.chart.scriptInputTemplates.v1';

/** Templates a script keeps at most; the oldest go first. */
export const MAX_TEMPLATES_PER_SCRIPT = 30;
/** Longest template name. */
export const MAX_TEMPLATE_NAME = 60;

export interface ScriptInputTemplate {
  name: string;
  /** The overrides it applies (only the inputs that differed from the defaults when saved). */
  values: ScriptInputValues;
  /** When it was saved (client ms). */
  savedAt: number;
}

/** Every script's templates, by {@link templateScope}. */
export type ScriptInputTemplates = Readonly<Record<string, readonly ScriptInputTemplate[]>>;

/**
 * Which script a template belongs to: a saved, engine or example script by its key (`mine:7`,
 * `strategy:12`, `example:rsi`) — it is the same script on every chart; a script from the editor
 * by its title, since its key is made afresh each time it is added.
 */
export function templateScope(item: { key: string; name?: string }, title?: string | null): string {
  return item.key.startsWith('editor:') ? `title:${title || item.name || 'Script'}` : item.key;
}

/** The templates saved in `storage`; none when nothing (or something unreadable) is there. */
export function readTemplates(storage: Pick<Storage, 'getItem'> | null | undefined): ScriptInputTemplates {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(SCRIPT_INPUT_TEMPLATES_KEY) ?? null;
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, ScriptInputTemplate[]> = {};
    for (const [scope, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter(isTemplate);
      if (kept.length) out[scope] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write the templates to `storage` (the chart prefs push them to the engine). */
export function writeTemplates(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  all: ScriptInputTemplates,
): void {
  try {
    storage?.setItem(SCRIPT_INPUT_TEMPLATES_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: the templates last for this page only.
  }
}

/**
 * `all` with a template saved under `scope`: a template of the same name (any case) is replaced,
 * and the newest come first. Null when the name is empty.
 */
export function withTemplate(
  all: ScriptInputTemplates,
  scope: string,
  name: string,
  values: ScriptInputValues,
  now = Date.now(),
): ScriptInputTemplates | null {
  const clean = name.trim().slice(0, MAX_TEMPLATE_NAME);
  if (!clean) return null;
  const others = (all[scope] ?? []).filter((t) => t.name.toLowerCase() !== clean.toLowerCase());
  const list = [{ name: clean, values: { ...values }, savedAt: now }, ...others].slice(
    0,
    MAX_TEMPLATES_PER_SCRIPT,
  );
  return { ...all, [scope]: list };
}

/** `all` without the template `name` of `scope`. */
export function withoutTemplate(
  all: ScriptInputTemplates,
  scope: string,
  name: string,
): ScriptInputTemplates {
  const list = (all[scope] ?? []).filter((t) => t.name !== name);
  const next: Record<string, readonly ScriptInputTemplate[]> = { ...all };
  if (list.length) next[scope] = list;
  else delete next[scope];
  return next;
}

function isTemplate(t: unknown): t is ScriptInputTemplate {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o['name'] === 'string' &&
    !!o['values'] &&
    typeof o['values'] === 'object' &&
    !Array.isArray(o['values']) &&
    typeof o['savedAt'] === 'number'
  );
}

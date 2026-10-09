import type { PineDebugRequest, PineDebugVariable } from '../model/pine-outputs.types';

/**
 * The Pine debugger pane's logic (PR-I11, `docs/api/scripting-api.md` §3e): the engine's own limits checked before a run, the
 * request built from what the operator typed, and the variables grouped by scope. Every value shown is the engine's.
 */

export const MAX_WATCHES = 10;
export const MAX_EXPRESSION_LENGTH = 500;
export const DEFAULT_MAX_HITS = 200;

/** What the operator typed in the pane. */
export interface DebugDraft {
  watches: string[];
  condition: string;
  /** Empty = the first bar / the last bar. */
  fromBar: string;
  toBar: string;
}

export function emptyDraft(): DebugDraft {
  return { watches: [''], condition: '', fromBar: '', toBar: '' };
}

/** The problems that would make the engine refuse the run, in plain words (empty = ready). */
export function debugProblems(d: DebugDraft): string[] {
  const problems: string[] = [];
  const watches = d.watches.map((w) => w.trim()).filter((w) => w.length > 0);
  if (watches.length === 0 && d.condition.trim() === '')
    problems.push('Add a watch expression or a condition.');
  if (watches.length > MAX_WATCHES) problems.push(`At most ${MAX_WATCHES} watch expressions.`);
  watches.forEach((w, i) => {
    if (w.length > MAX_EXPRESSION_LENGTH)
      problems.push(`Watch ${i + 1} is longer than ${MAX_EXPRESSION_LENGTH} characters.`);
  });
  if (d.condition.trim().length > MAX_EXPRESSION_LENGTH)
    problems.push(`The condition is longer than ${MAX_EXPRESSION_LENGTH} characters.`);
  const from = bar(d.fromBar);
  const to = bar(d.toBar);
  if (from === undefined) problems.push('"From bar" must be a whole number of 0 or more.');
  if (to === undefined) problems.push('"To bar" must be a whole number of 0 or more.');
  if (typeof from === 'number' && typeof to === 'number' && to < from)
    problems.push('"To bar" comes before "From bar".');
  return problems;
}

/** The §3e `debug` object for a draft with no problems. */
export function debugRequest(d: DebugDraft, stateAtBar: number | null = null): PineDebugRequest {
  const condition = d.condition.trim();
  return {
    watches: d.watches.map((w) => w.trim()).filter((w) => w.length > 0),
    condition: condition === '' ? null : condition,
    fromBar: bar(d.fromBar) ?? 0,
    toBar: bar(d.toBar) ?? null,
    maxHits: DEFAULT_MAX_HITS,
    stateAtBar,
  };
}

/** A typed bar index: null when empty, undefined when not a whole number ≥ 0. */
function bar(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return undefined;
  return Number(t);
}

/**
 * The watch that reads a variable of the list: a global by its name; a function's own variable as `f(): name`, which the
 * engine evaluates inside f after each call (one value per call site: the one after its last call on the bar).
 */
export function watchExpressionFor(v: Pick<PineDebugVariable, 'scope' | 'name'>): string {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\(\)/.exec(v.scope);
  return v.scope === 'global' || !m ? v.name : `${m[1]}(): ${v.name}`;
}

/** The draft with `expression` watched: in the first empty watch box, else a new one (unchanged when already watched or full). */
export function withWatch(d: DebugDraft, expression: string): DebugDraft {
  if (d.watches.some((w) => w.trim() === expression)) return d;
  const empty = d.watches.findIndex((w) => w.trim() === '');
  if (empty >= 0) return { ...d, watches: d.watches.map((w, k) => (k === empty ? expression : w)) };
  return d.watches.length < MAX_WATCHES ? { ...d, watches: [...d.watches, expression] } : d;
}

export interface ScopeGroup {
  scope: string;
  variables: PineDebugVariable[];
}

/** The variables by scope, in the engine's order (global first), optionally filtered by name. */
export function groupByScope(vars: readonly PineDebugVariable[], filter = ''): ScopeGroup[] {
  const f = filter.trim().toLowerCase();
  const groups: ScopeGroup[] = [];
  const index = new Map<string, ScopeGroup>();
  for (const v of vars) {
    if (f && !v.name.toLowerCase().includes(f)) continue;
    let g = index.get(v.scope);
    if (!g) {
      g = { scope: v.scope, variables: [] };
      index.set(v.scope, g);
      groups.push(g);
    }
    g.variables.push(v);
  }
  return groups;
}

/** "var" / "varip" / "" (a value recomputed on every bar shows no badge). */
export function kindBadge(kind: string): string {
  return kind === 'var' || kind === 'varip' ? kind : '';
}

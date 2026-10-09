import type {
  OptimizationObjective,
  ParameterSpaceDto,
  SearchConstraints,
  SearchDimensionKind,
  SearchRange,
  SearchSpec,
  SearchedInputDto,
  SkippedInputDto,
} from './research.types';

/**
 * The optimizer search-space editor (PE-I4, scripting API §8a) as plain data: the operator's draft — per searched input
 * a range or a lock, locks on inputs the optimizer does not search, the objective and the constraints — and the search
 * spec it becomes. The engine's preview (`POST …/parameter-space`) is the authority on whether a spec fits the script;
 * these checks only catch what can be said before asking (a number that is not a number, min ≥ max).
 */

export const OBJECTIVES: readonly { id: OptimizationObjective; label: string; hint: string }[] = [
  {
    id: 'HealthScore',
    label: 'Health score',
    hint: 'The default: the optimizer’s five-factor health score.',
  },
  {
    id: 'ExpectancyR',
    label: 'Expectancy (R per trade)',
    hint: 'Mean R multiple — needs trades with a stop.',
  },
  { id: 'SharpeRatio', label: 'Sharpe ratio', hint: 'Mean of the folds’ Sharpe ratios.' },
  { id: 'SortinoRatio', label: 'Sortino ratio', hint: 'Mean of the folds’ Sortino ratios.' },
  {
    id: 'ProfitFactor',
    label: 'Profit factor',
    hint: 'Gross profit ÷ gross loss over the folds (capped at 10).',
  },
];

/** One searched input as the operator edits it: search a (narrower) range, or hold it at one value. */
export interface DimensionDraft {
  id: string;
  title: string;
  group: string | null;
  kind: SearchDimensionKind;
  mode: 'search' | 'lock';
  /** Numbers as typed (strings), so a half-typed value never jumps. */
  min: string;
  max: string;
  step: string;
  /** Choice inputs: every option the input accepts, and those searched. */
  options: unknown[];
  chosen: unknown[];
  /** The value held when locked: a typed number, or an option. */
  lockValue: unknown;
  /** The range the engine searches without a spec (declared, derived, options …), to tell a change from the default. */
  original: { min: number | null; max: number | null; step: number | null; choices: unknown[] };
  rangeSource: string;
  current: unknown;
  declared: { min: number | null; max: number | null; step: number | null };
}

/** An input the optimizer does not search; it can still be held at a value. */
export interface SkippedDraft {
  id: string;
  title: string;
  inputKind: string;
  reason: string;
  locked: boolean;
  lockValue: string;
  current: unknown;
}

/** Constraint fields as typed. Win rate is entered as a percent (45) and sent as a fraction (0.45). */
export interface ConstraintsDraft {
  minTrades: string;
  maxDrawdownPct: string;
  minWinRatePct: string;
  minProfitFactor: string;
  minExpectancyR: string;
}

export interface SpecDraft {
  dimensions: DimensionDraft[];
  skipped: SkippedDraft[];
  objective: OptimizationObjective;
  constraints: ConstraintsDraft;
}

export const EMPTY_CONSTRAINTS: ConstraintsDraft = {
  minTrades: '',
  maxDrawdownPct: '',
  minWinRatePct: '',
  minProfitFactor: '',
  minExpectancyR: '',
};

function text(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '' : String(v);
}

/** The editor's starting point: the space the engine searches by default (or as a previous spec shaped it). */
export function draftFromSpace(space: ParameterSpaceDto): SpecDraft {
  const spec = space.searchSpec;
  const dimensions = space.searched.map((d) => dimensionDraft(d));
  const skipped = space.skipped.map(
    (s): SkippedDraft => ({
      id: s.id,
      title: s.title || s.id,
      inputKind: s.inputKind,
      reason: s.reason,
      locked: s.locked,
      lockValue: s.locked ? valueText(s.lockedValue) : valueText(s.current),
      current: s.current,
    }),
  );
  return {
    dimensions,
    skipped,
    objective: (spec?.objective as OptimizationObjective | undefined) ?? 'HealthScore',
    constraints: constraintsDraft(spec?.constraints ?? null),
  };
}

function dimensionDraft(d: SearchedInputDto): DimensionDraft {
  const choices = d.choices ?? [];
  return {
    id: d.id,
    title: d.title || d.id,
    group: d.group,
    kind: d.kind,
    mode: 'search',
    min: text(d.min),
    max: text(d.max),
    step: text(d.step),
    options: d.options ?? choices,
    chosen: [...choices],
    lockValue: d.kind === 'choice' ? d.current : valueText(d.current),
    original: { min: d.min, max: d.max, step: d.step, choices: [...choices] },
    rangeSource: String(d.rangeSource ?? ''),
    current: d.current,
    declared: { min: d.declaredMin, max: d.declaredMax, step: d.declaredStep },
  };
}

function constraintsDraft(c: SearchConstraints | null): ConstraintsDraft {
  if (!c) return { ...EMPTY_CONSTRAINTS };
  return {
    minTrades: text(c.minTrades),
    maxDrawdownPct: text(c.maxDrawdownPct),
    minWinRatePct:
      c.minWinRate === null || c.minWinRate === undefined
        ? ''
        : String(round(c.minWinRate * 100, 6)),
    minProfitFactor: text(c.minProfitFactor),
    minExpectancyR: text(c.minExpectancyR),
  };
}

/** A JSON value as an input shows it ("true", "14", "close"). */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function parseNumber(raw: string): number | null | 'bad' {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : 'bad';
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A lock value typed for a skipped input: JSON when it parses (numbers, booleans), else the text itself. */
export function parseLockText(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  return raw;
}

export interface BuiltSpec {
  spec: SearchSpec;
  /** What can be told before asking the engine (a value that is not a number, min ≥ max …). */
  problems: string[];
  /** True when the spec shapes nothing (no range, lock, objective or constraint): the run is an ordinary one. */
  isDefault: boolean;
}

/** The search spec a draft asks for. Ranges equal to the engine's own are left out (the engine searches them anyway). */
export function buildSpec(draft: SpecDraft): BuiltSpec {
  const ranges: Record<string, SearchRange> = {};
  const locked: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const d of draft.dimensions) {
    const label = d.title || d.id;
    if (d.mode === 'lock') {
      if (d.kind === 'choice') {
        locked[d.id] = d.lockValue;
      } else {
        const v = parseNumber(String(d.lockValue ?? ''));
        if (v === null || v === 'bad') problems.push(`${label}: enter the value to hold it at.`);
        else if (d.kind === 'integer' && !Number.isInteger(v))
          problems.push(`${label}: the value must be a whole number.`);
        else locked[d.id] = v;
      }
      continue;
    }
    if (d.kind === 'choice') {
      if (d.chosen.length < 2) {
        problems.push(`${label}: search at least two options, or hold it at one.`);
        continue;
      }
      const same =
        d.chosen.length === d.original.choices.length &&
        d.chosen.every((c) => d.original.choices.some((o) => sameValue(o, c)));
      if (!same) ranges[d.id] = { choices: [...d.chosen] };
      continue;
    }
    const min = parseNumber(d.min);
    const max = parseNumber(d.max);
    const step = parseNumber(d.step);
    if (min === 'bad' || max === 'bad' || step === 'bad' || min === null || max === null) {
      problems.push(`${label}: enter a number for the lowest and highest value.`);
      continue;
    }
    if (min >= max) {
      problems.push(`${label}: the lowest value must be below the highest.`);
      continue;
    }
    if (step !== null && step < 0) {
      problems.push(`${label}: the step cannot be negative.`);
      continue;
    }
    if (d.kind === 'integer') {
      if (!Number.isInteger(min) || !Number.isInteger(max)) {
        problems.push(`${label}: a whole-number input needs whole-number bounds.`);
        continue;
      }
      if (step !== null && (step === 0 || !Number.isInteger(step))) {
        problems.push(`${label}: a whole-number input needs a whole-number step of at least 1.`);
        continue;
      }
    }
    const unchanged =
      min === d.original.min &&
      max === d.original.max &&
      (step ?? null) === (d.original.step ?? null);
    if (!unchanged) ranges[d.id] = step === null ? { min, max } : { min, max, step };
  }

  for (const s of draft.skipped) {
    if (!s.locked) continue;
    if (s.lockValue.trim() === '') problems.push(`${s.title}: enter the value to hold it at.`);
    else locked[s.id] = parseLockText(s.lockValue);
  }

  const constraints = buildConstraints(draft.constraints, problems);
  const spec: SearchSpec = { ranges, locked, objective: draft.objective };
  if (constraints) spec.constraints = constraints;
  const isDefault =
    Object.keys(ranges).length === 0 &&
    Object.keys(locked).length === 0 &&
    draft.objective === 'HealthScore' &&
    !constraints;
  return { spec, problems, isDefault };
}

function buildConstraints(c: ConstraintsDraft, problems: string[]): SearchConstraints | null {
  const out: SearchConstraints = {};
  const read = (raw: string, label: string, check: (v: number) => string | null): number | null => {
    const v = parseNumber(raw);
    if (v === null) return null;
    if (v === 'bad') {
      problems.push(`${label}: enter a number.`);
      return null;
    }
    const problem = check(v);
    if (problem) {
      problems.push(`${label}: ${problem}`);
      return null;
    }
    return v;
  };
  const minTrades = read(c.minTrades, 'Minimum trades', (v) =>
    Number.isInteger(v) && v >= 1 ? null : 'a whole number of at least 1.',
  );
  const maxDd = read(c.maxDrawdownPct, 'Maximum drawdown', (v) =>
    v > 0 && v < 100 ? null : 'a percent above 0 and below 100.',
  );
  const minWin = read(c.minWinRatePct, 'Minimum win rate', (v) =>
    v >= 0 && v <= 100 ? null : 'a percent from 0 to 100.',
  );
  const minPf = read(c.minProfitFactor, 'Minimum profit factor', (v) =>
    v >= 0 ? null : '0 or more.',
  );
  const minR = read(c.minExpectancyR, 'Minimum expectancy', (v) =>
    v >= -10 && v <= 10 ? null : 'between −10 and 10 R per trade.',
  );
  if (minTrades !== null) out.minTrades = minTrades;
  if (maxDd !== null) out.maxDrawdownPct = maxDd;
  if (minWin !== null) out.minWinRate = round(minWin / 100, 6);
  if (minPf !== null) out.minProfitFactor = minPf;
  if (minR !== null) out.minExpectancyR = minR;
  return Object.keys(out).length === 0 ? null : out;
}

/** The spec in plain words, one line per decision — what the run will do differently from an ordinary one. */
export function specSummary(spec: SearchSpec, space: ParameterSpaceDto | null): string[] {
  const titleOf = (id: string) =>
    space?.searched.find((d) => d.id === id)?.title ||
    space?.skipped.find((d) => d.id === id)?.title ||
    id;
  const lines: string[] = [];
  for (const [id, r] of Object.entries(spec.ranges)) {
    if (r.choices) lines.push(`${titleOf(id)}: search ${r.choices.map(valueText).join(', ')}`);
    else
      lines.push(
        `${titleOf(id)}: search ${r.min} to ${r.max}${r.step ? ` in steps of ${r.step}` : ''}`,
      );
  }
  for (const [id, v] of Object.entries(spec.locked))
    lines.push(`${titleOf(id)}: held at ${valueText(v)}`);
  if (spec.objective !== 'HealthScore') {
    lines.push(
      `Ranks candidates by ${OBJECTIVES.find((o) => o.id === spec.objective)?.label ?? spec.objective}`,
    );
  }
  const c = spec.constraints;
  if (c) {
    if (c.minTrades != null) lines.push(`At least ${c.minTrades} trades`);
    if (c.maxDrawdownPct != null) lines.push(`Drawdown at most ${c.maxDrawdownPct} %`);
    if (c.minWinRate != null) lines.push(`Win rate at least ${round(c.minWinRate * 100, 4)} %`);
    if (c.minProfitFactor != null) lines.push(`Profit factor at least ${c.minProfitFactor}`);
    if (c.minExpectancyR != null) lines.push(`Expectancy at least ${c.minExpectancyR} R per trade`);
  }
  return lines;
}

/** Where a searched input's default range comes from, in words. */
export function rangeSourceText(source: string): string {
  switch (source) {
    case 'spec':
      return 'set by this spec';
    case 'declared':
      return 'the script’s minval / maxval';
    case 'derived':
      return 'half to twice the current value';
    case 'options':
      return 'the input’s options';
    case 'enum':
      return 'the enum’s members';
    case 'bool':
      return 'true / false';
    default:
      return source;
  }
}

/** The engine's shaped value for one dimension after a preview, for the "the engine will search …" hint. */
export function shapedRangeText(d: SearchedInputDto | undefined): string | null {
  if (!d) return null;
  if (d.kind === 'choice') return (d.choices ?? []).map(valueText).join(', ');
  if (d.min === null || d.max === null) return null;
  return `${d.min} – ${d.max}${d.step ? ` step ${d.step}` : ''}`;
}

/** A skipped input's draft with its lock toggled. */
export function toggleSkippedLock(s: SkippedDraft, locked: boolean): SkippedDraft {
  return { ...s, locked };
}

/** Plain list of the skipped inputs that cannot be searched, for a hint under the editor. */
export function skippedReasons(skipped: readonly SkippedInputDto[]): string[] {
  return skipped.map((s) => `${s.title || s.id}: ${s.reason}`);
}

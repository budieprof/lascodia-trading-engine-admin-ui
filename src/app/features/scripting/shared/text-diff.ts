/**
 * Line diff for Pine sources (version history, save conflicts, library versions) — written here
 * because the console carries no diff package and a script can run to a few thousand lines.
 *
 * <p>{@link diffLines} trims the common head and tail, then runs Myers' O(ND) algorithm over the
 * rest with lines interned as integers. Its trace needs O(D²) memory, so it stops at
 * {@link MAX_ALIGNED_EDITS} edits: beyond that the differing middle is reported as replaced
 * wholesale and {@link LineDiff.approximate} says so — never a wrong alignment presented as a
 * real one.</p>
 *
 * <p>{@link sideBySide} pairs each run of removed lines with the added lines next to it (a
 * "changed" row marks the characters that differ), and {@link collapseUnchanged} folds long runs
 * of unchanged lines the way a code review does.</p>
 */

/** Edit budget of an aligned diff (about 4 MB of trace at the limit). */
export const MAX_ALIGNED_EDITS = 2000;

export type LineEditKind = 'equal' | 'delete' | 'insert';

export interface LineEdit {
  kind: LineEditKind;
  /** 0-based line of the old text (equal / delete), else -1. */
  a: number;
  /** 0-based line of the new text (equal / insert), else -1. */
  b: number;
}

export interface LineDiff {
  oldLines: string[];
  newLines: string[];
  edits: LineEdit[];
  added: number;
  removed: number;
  /** The texts differ in more lines than are aligned one by one: the middle is shown as replaced. */
  approximate: boolean;
}

/** Splits a source into lines (`\r\n`, `\r` and `\n` all end one). An empty text has no lines. */
export function splitLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** The line edits turning `oldText` into `newText`. */
export function diffLines(
  oldText: string | null | undefined,
  newText: string | null | undefined,
  maxEdits = MAX_ALIGNED_EDITS,
): LineDiff {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const ids = new Map<string, number>();
  const intern = (line: string): number => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const a = Int32Array.from(oldLines, intern);
  const b = Int32Array.from(newLines, intern);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const edits: LineEdit[] = [];
  for (let i = 0; i < head; i++) edits.push({ kind: 'equal', a: i, b: i });

  const midA = a.subarray(head, a.length - tail);
  const midB = b.subarray(head, b.length - tail);
  const middle = myers(midA, midB, maxEdits);
  let approximate = false;
  if (middle) {
    for (const e of middle) {
      edits.push({
        kind: e.kind,
        a: e.a < 0 ? -1 : e.a + head,
        b: e.b < 0 ? -1 : e.b + head,
      });
    }
  } else {
    approximate = true;
    for (let i = 0; i < midA.length; i++) edits.push({ kind: 'delete', a: head + i, b: -1 });
    for (let j = 0; j < midB.length; j++) edits.push({ kind: 'insert', a: -1, b: head + j });
  }

  for (let i = 0; i < tail; i++) {
    edits.push({ kind: 'equal', a: a.length - tail + i, b: b.length - tail + i });
  }
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    if (e.kind === 'insert') added++;
    else if (e.kind === 'delete') removed++;
  }
  return { oldLines, newLines, edits, added, removed, approximate };
}

/**
 * Myers' shortest edit script between two interned line arrays, or null when it needs more than
 * `maxEdits` edits. Each step's frontier is kept (only the diagonals it can reach), which is what
 * the backtrack reads.
 */
function myers(a: Int32Array, b: Int32Array, maxEdits: number): LineEdit[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return Array.from({ length: m }, (_, j) => ({ kind: 'insert' as const, a: -1, b: j }));
  if (m === 0) return Array.from({ length: n }, (_, i) => ({ kind: 'delete' as const, a: i, b: -1 }));

  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  v[offset + 1] = 0;
  // trace[d] = the frontier before step d, diagonals -(d+1)..(d+1).
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;

  const out: LineEdit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const frontier = trace[d];
    const at = (k: number) => frontier[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ kind: 'equal', a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ kind: 'insert', a: -1, b: prevY });
      else out.push({ kind: 'delete', a: prevX, b: -1 });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

// ── Side by side ─────────────────────────────────────────────────────────────

export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DiffCell {
  /** 1-based line number. */
  no: number;
  text: string;
  /** For a changed row: the line split into unchanged and changed parts. */
  segments: DiffSegment[] | null;
}

export type DiffRowKind = 'equal' | 'removed' | 'added' | 'changed';

export interface DiffRow {
  kind: DiffRowKind;
  left: DiffCell | null;
  right: DiffCell | null;
}

/** Rows for a two-column view: removed lines on the left, added on the right, paired when both. */
export function sideBySide(diff: LineDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  let dels: number[] = [];
  let ins: number[] = [];
  const flush = () => {
    const pairs = Math.min(dels.length, ins.length);
    for (let i = 0; i < pairs; i++) {
      const before = diff.oldLines[dels[i]];
      const after = diff.newLines[ins[i]];
      const [l, r] = changedSegments(before, after);
      rows.push({
        kind: 'changed',
        left: { no: dels[i] + 1, text: before, segments: l },
        right: { no: ins[i] + 1, text: after, segments: r },
      });
    }
    for (let i = pairs; i < dels.length; i++) {
      rows.push({
        kind: 'removed',
        left: { no: dels[i] + 1, text: diff.oldLines[dels[i]], segments: null },
        right: null,
      });
    }
    for (let i = pairs; i < ins.length; i++) {
      rows.push({
        kind: 'added',
        left: null,
        right: { no: ins[i] + 1, text: diff.newLines[ins[i]], segments: null },
      });
    }
    dels = [];
    ins = [];
  };
  for (const e of diff.edits) {
    if (e.kind === 'delete') dels.push(e.a);
    else if (e.kind === 'insert') ins.push(e.b);
    else {
      flush();
      rows.push({
        kind: 'equal',
        left: { no: e.a + 1, text: diff.oldLines[e.a], segments: null },
        right: { no: e.b + 1, text: diff.newLines[e.b], segments: null },
      });
    }
  }
  flush();
  return rows;
}

/** The two lines split at their common head and tail: what differs is marked changed. */
export function changedSegments(before: string, after: string): [DiffSegment[], DiffSegment[]] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  const split = (s: string): DiffSegment[] =>
    [
      { text: s.slice(0, head), changed: false },
      { text: s.slice(head, s.length - tail), changed: true },
      { text: s.slice(s.length - tail), changed: false },
    ].filter((seg) => seg.text.length > 0);
  return [split(before), split(after)];
}

export type DiffBlock =
  | { kind: 'rows'; rows: DiffRow[] }
  /** Unchanged lines folded away; `index` identifies the fold for expanding it. */
  | { kind: 'gap'; index: number; rows: DiffRow[] };

/**
 * Folds runs of unchanged rows that lie more than `context` rows from any change, when the fold
 * would hide at least `minGap` rows. With no change at all, everything folds into one gap.
 */
export function collapseUnchanged(rows: readonly DiffRow[], context = 3, minGap = 4): DiffBlock[] {
  const near = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === 'equal') continue;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) {
      near[j] = 1;
    }
  }
  const blocks: DiffBlock[] = [];
  let shown: DiffRow[] = [];
  let gapIndex = 0;
  let i = 0;
  while (i < rows.length) {
    if (near[i] || rows[i].kind !== 'equal') {
      shown.push(rows[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && !near[j] && rows[j].kind === 'equal') j++;
    const run = rows.slice(i, j);
    if (run.length >= minGap) {
      if (shown.length) blocks.push({ kind: 'rows', rows: shown });
      shown = [];
      blocks.push({ kind: 'gap', index: gapIndex++, rows: run });
    } else {
      shown.push(...run);
    }
    i = j;
  }
  if (shown.length) blocks.push({ kind: 'rows', rows: shown });
  return blocks;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export type InputChangeKind = 'added' | 'removed' | 'changed';

export interface InputChange {
  id: string;
  kind: InputChangeKind;
  before?: unknown;
  after?: unknown;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-12;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/** Input overrides added, removed or changed between two saved sets, by input id. */
export function diffInputValues(
  before: Readonly<Record<string, unknown>> | null | undefined,
  after: Readonly<Record<string, unknown>> | null | undefined,
): InputChange[] {
  const b = before ?? {};
  const a = after ?? {};
  const ids = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort((x, y) =>
    x.localeCompare(y),
  );
  const changes: InputChange[] = [];
  for (const id of ids) {
    const inB = Object.prototype.hasOwnProperty.call(b, id);
    const inA = Object.prototype.hasOwnProperty.call(a, id);
    if (inB && !inA) changes.push({ id, kind: 'removed', before: b[id] });
    else if (!inB && inA) changes.push({ id, kind: 'added', after: a[id] });
    else if (!sameValue(b[id], a[id])) changes.push({ id, kind: 'changed', before: b[id], after: a[id] });
  }
  return changes;
}

/** "Fast length" (from a `Group::Title` input id) or the id itself. */
export function inputLabel(id: string): string {
  const i = id.lastIndexOf('::');
  return i >= 0 ? id.slice(i + 2) : id;
}

/** A value as the inputs table prints it. */
export function formatInputValue(v: unknown): string {
  if (v === undefined) return '(default)';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Structural diff between two JSON values, for the strategy version history.
 *
 * Produces one row per changed path (`entryConditionsRoot.children[1].leaf
 * .indicatorThreshold.value`) instead of two truncated blobs, so a one-number
 * edit inside a long DSL reads as one line. Object keys match
 * case-insensitively — the engine reads the JSON that way, so a rule re-saved
 * in camelCase does not show every key as removed and re-added. Arrays are
 * aligned on their unchanged elements first, so inserting a condition shows
 * as one addition rather than every later sibling "changing".
 */

export type DiffKind = 'added' | 'removed' | 'changed';

export interface DiffRow {
  /** Dotted path; array elements as `[i]` (the new index, or the old one for removals). */
  path: string;
  kind: DiffKind;
  before?: unknown;
  after?: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Canonical form for equality: keys lower-cased and sorted. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .map((k) => [k.toLowerCase(), k] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([lk, k]) => `${JSON.stringify(lk)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

const join = (base: string, key: string) => (base ? `${base}.${key}` : key);

/** Longest common subsequence of equal elements, as index pairs. */
function lcsPairs(a: unknown[], b: unknown[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > 40_000) return [];
  const ca = a.map(canonical);
  const cb = b.map(canonical);
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ca[i] === cb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ca[i] === cb[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function diffArrays(before: unknown[], after: unknown[], path: string, out: DiffRow[]): void {
  const anchors = [...lcsPairs(before, after), [before.length, after.length] as [number, number]];
  let i = 0;
  let j = 0;
  for (const [ai, aj] of anchors) {
    // Between two anchors, pair elements up positionally (an edited element
    // diffs field by field); whatever is left over was removed or added.
    const pairs = Math.min(ai - i, aj - j);
    for (let k = 0; k < pairs; k++) diffInto(before[i + k], after[j + k], `${path}[${j + k}]`, out);
    for (let k = i + pairs; k < ai; k++)
      out.push({ path: `${path}[${k}]`, kind: 'removed', before: before[k] });
    for (let k = j + pairs; k < aj; k++)
      out.push({ path: `${path}[${k}]`, kind: 'added', after: after[k] });
    i = ai + 1;
    j = aj + 1;
  }
}

function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string,
  out: DiffRow[],
): void {
  const unmatched = new Set(Object.keys(after));
  for (const bk of Object.keys(before)) {
    let ak: string | undefined = bk in after ? bk : undefined;
    if (ak === undefined) {
      ak = [...unmatched].find((k) => k.toLowerCase() === bk.toLowerCase());
    }
    if (ak === undefined) {
      out.push({ path: join(path, bk), kind: 'removed', before: before[bk] });
      continue;
    }
    unmatched.delete(ak);
    diffInto(before[bk], after[ak], join(path, ak), out);
  }
  for (const ak of Object.keys(after)) {
    if (unmatched.has(ak)) out.push({ path: join(path, ak), kind: 'added', after: after[ak] });
  }
}

function diffInto(before: unknown, after: unknown, path: string, out: DiffRow[]): void {
  if (jsonEqual(before, after)) return;
  if (before === undefined) {
    out.push({ path, kind: 'added', after });
    return;
  }
  if (after === undefined) {
    out.push({ path, kind: 'removed', before });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    diffArrays(before, after, path, out);
    return;
  }
  if (isObject(before) && isObject(after)) {
    diffObjects(before, after, path, out);
    return;
  }
  out.push({ path, kind: 'changed', before, after });
}

/** Every difference between two JSON values, one row per path. */
export function diffJson(before: unknown, after: unknown, basePath = ''): DiffRow[] {
  const out: DiffRow[] = [];
  diffInto(before, after, basePath, out);
  return out;
}

/**
 * Diff of one stored text field. JSON on both sides (an empty side counts as
 * absent) diffs structurally under `field`; anything else is one row holding
 * both full values — never truncated.
 */
export function diffTextField(
  field: string,
  before: string | number | null | undefined,
  after: string | number | null | undefined,
  opts: { json?: boolean } = {},
): DiffRow[] {
  const norm = (v: string | number | null | undefined) =>
    v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v;
  const b = norm(before);
  const a = norm(after);
  if (b === a) return [];
  if (opts.json) {
    const parse = (v: string | number | undefined): { ok: boolean; value: unknown } => {
      if (v === undefined) return { ok: true, value: undefined };
      try {
        return { ok: true, value: JSON.parse(String(v)) };
      } catch {
        return { ok: false, value: v };
      }
    };
    const pb = parse(b);
    const pa = parse(a);
    if (pb.ok && pa.ok) return diffJson(pb.value, pa.value, field);
  }
  if (b === undefined) return [{ path: field, kind: 'added', after: a }];
  if (a === undefined) return [{ path: field, kind: 'removed', before: b }];
  return [{ path: field, kind: 'changed', before: b, after: a }];
}

/** Display text for one side of a diff row: JSON literals, pretty-printed structures. */
export function formatDiffValue(v: unknown): string {
  if (v === undefined) return '∅';
  if (typeof v === 'string') return JSON.stringify(v);
  if (v !== null && typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

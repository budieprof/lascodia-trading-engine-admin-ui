/**
 * Line-level LCS (Longest Common Subsequence) diff. Pure TS, ~50 LOC. No NPM
 * dependency — the prompt-templates diff page renders large (20-60KB) prompt
 * bodies and pulling in a generic diff library felt heavy for the single
 * caller. Algorithm choice:
 *
 *  - Compare on full-line equality (engine prompts are line-oriented; intra-
 *    line diffs aren't needed for the operator's "what changed" workflow).
 *  - Time / memory: O(M·N) tab build. With M, N ~ 1-3K lines this stays in
 *    the single-digit-millions of cells which Chrome's V8 munches through in
 *    a few ms.
 *  - Output format: a flat array of {kind, line, leftLine?, rightLine?} so
 *    the renderer can map 1:1 to JSX/Angular template chunks without any
 *    extra grouping logic.
 */

/** One row of the unified diff. */
export type LineDiffKind = 'equal' | 'remove' | 'add';

export interface LineDiffRow {
  kind: LineDiffKind;
  /** The line text (no trailing newline). */
  text: string;
  /** 1-based line number in the LEFT (baseline) input; null on `add` rows. */
  leftLineNumber: number | null;
  /** 1-based line number in the RIGHT (candidate) input; null on `remove` rows. */
  rightLineNumber: number | null;
}

export interface LineDiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

export interface LineDiffResult {
  rows: LineDiffRow[];
  stats: LineDiffStats;
}

/**
 * Compute a unified line-diff between `left` and `right`. Inputs are split
 * on `\r?\n` (Windows + Unix line endings tolerated); a single trailing
 * blank line from a terminal newline is preserved so it's visible in the
 * diff output.
 */
export function lineDiff(left: string, right: string): LineDiffResult {
  const a = left.split(/\r?\n/);
  const b = right.split(/\r?\n/);
  const m = a.length;
  const n = b.length;

  // Build LCS length table. `dp[i][j]` = LCS length of a[0..i) vs b[0..j).
  // Use Int32Array for the row to keep allocation light on large prompts.
  const dp: number[][] = new Array(m + 1);
  for (let i = 0; i <= m; i++) {
    dp[i] = Array.from(new Int32Array(n + 1));
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce rows in correct order.
  const rows: LineDiffRow[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      rows.push({ kind: 'equal', text: a[i - 1], leftLineNumber: i, rightLineNumber: j });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      rows.push({ kind: 'remove', text: a[i - 1], leftLineNumber: i, rightLineNumber: null });
      i--;
    } else {
      rows.push({ kind: 'add', text: b[j - 1], leftLineNumber: null, rightLineNumber: j });
      j--;
    }
  }
  while (i > 0) {
    rows.push({ kind: 'remove', text: a[i - 1], leftLineNumber: i, rightLineNumber: null });
    i--;
  }
  while (j > 0) {
    rows.push({ kind: 'add', text: b[j - 1], leftLineNumber: null, rightLineNumber: j });
    j--;
  }
  rows.reverse();

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const r of rows) {
    if (r.kind === 'add') added++;
    else if (r.kind === 'remove') removed++;
    else unchanged++;
  }
  return { rows, stats: { added, removed, unchanged } };
}

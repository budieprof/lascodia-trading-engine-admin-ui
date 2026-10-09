import { describe, expect, it } from 'vitest';

import {
  changedSegments,
  collapseUnchanged,
  diffInputValues,
  diffLines,
  formatInputValue,
  inputLabel,
  sideBySide,
  splitLines,
  type LineDiff,
} from './text-diff';

/** Rebuilds the new text from the old one and the edits — the defining property of a diff. */
function apply(d: LineDiff): string[] {
  const out: string[] = [];
  for (const e of d.edits) {
    if (e.kind === 'equal') {
      expect(d.oldLines[e.a]).toBe(d.newLines[e.b]);
      out.push(d.oldLines[e.a]);
    } else if (e.kind === 'insert') out.push(d.newLines[e.b]);
  }
  return out;
}

/** Old lines in order: equal + deletes must walk the old text exactly once. */
function oldWalk(d: LineDiff): number[] {
  return d.edits.filter((e) => e.kind !== 'insert').map((e) => e.a);
}

function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n');
}

describe('text-diff — diffLines', () => {
  it('splits CRLF, CR and LF alike; an empty text has no lines', () => {
    expect(splitLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines(null)).toEqual([]);
  });

  it('identical texts are all equal', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc');
    expect(d.edits.every((e) => e.kind === 'equal')).toBe(true);
    expect([d.added, d.removed, d.approximate]).toEqual([0, 0, false]);
  });

  it('one changed line in the middle is one delete and one insert', () => {
    const d = diffLines('a\nb\nc\nd', 'a\nB\nc\nd');
    expect(d.edits.map((e) => e.kind)).toEqual(['equal', 'delete', 'insert', 'equal', 'equal']);
    expect([d.added, d.removed]).toEqual([1, 1]);
    expect(apply(d)).toEqual(['a', 'B', 'c', 'd']);
  });

  it('insertions and removals at the edges', () => {
    expect(apply(diffLines('b\nc', 'a\nb\nc\nd'))).toEqual(['a', 'b', 'c', 'd']);
    expect(diffLines('a\nb\nc', 'b').removed).toBe(2);
    expect(diffLines('', 'x\ny').added).toBe(2);
    expect(diffLines('x\ny', '').removed).toBe(2);
  });

  it('finds the shortest edit script, not a positional one', () => {
    // Inserting a block shifts everything after it: only the block is added.
    const before = lines(50);
    const after = [...splitLines(before).slice(0, 20), 'new 1', 'new 2', ...splitLines(before).slice(20)].join('\n');
    const d = diffLines(before, after);
    expect([d.added, d.removed]).toEqual([2, 0]);
    expect(apply(d)).toEqual(splitLines(after));
    expect(oldWalk(d)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('agrees with the edit distance on scattered edits', () => {
    const a = 'a\nb\nc\na\nb\nb\na'.split('\n');
    const b = 'c\nb\na\nb\na\nc'.split('\n');
    const d = diffLines(a.join('\n'), b.join('\n'));
    // The classic Myers example: D = 5.
    expect(d.added + d.removed).toBe(5);
    expect(apply(d)).toEqual(b);
  });

  it('stays exact on random edits of a long script', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const base = splitLines(lines(1500, 'x'));
    const edited: string[] = [];
    for (const l of base) {
      const r = rnd();
      if (r < 0.02) continue; // removed
      edited.push(r < 0.04 ? `${l} (edited)` : l);
      if (rnd() < 0.01) edited.push('inserted');
    }
    const d = diffLines(base.join('\n'), edited.join('\n'));
    expect(d.approximate).toBe(false);
    expect(apply(d)).toEqual(edited);
    expect(oldWalk(d)).toEqual(base.map((_, i) => i));
  });

  it('beyond the edit budget the differing middle is replaced wholesale — and says so', () => {
    const d = diffLines('head\n' + lines(30, 'a') + '\ntail', 'head\n' + lines(30, 'b') + '\ntail', 10);
    expect(d.approximate).toBe(true);
    expect([d.removed, d.added]).toEqual([30, 30]);
    expect(d.edits[0]).toEqual({ kind: 'equal', a: 0, b: 0 });
    expect(d.edits.at(-1)).toEqual({ kind: 'equal', a: 31, b: 31 });
    expect(apply(d)).toEqual(splitLines('head\n' + lines(30, 'b') + '\ntail'));
  });
});

describe('text-diff — side by side', () => {
  it('pairs removed and added lines into changed rows and marks what differs', () => {
    const rows = sideBySide(diffLines('a\nlen = 9\nc', 'a\nlen = 21\nnew\nc'));
    expect(rows.map((r) => r.kind)).toEqual(['equal', 'changed', 'added', 'equal']);
    const changed = rows[1];
    expect([changed.left?.no, changed.right?.no]).toEqual([2, 2]);
    expect(changed.left?.segments).toEqual([
      { text: 'len = ', changed: false },
      { text: '9', changed: true },
    ]);
    expect(changed.right?.segments).toEqual([
      { text: 'len = ', changed: false },
      { text: '21', changed: true },
    ]);
    expect(rows[2].left).toBeNull();
    expect(rows[2].right?.text).toBe('new');
  });

  it('changedSegments keeps the common head and tail unmarked', () => {
    expect(changedSegments('plot(x, "A")', 'plot(y, "A")')).toEqual([
      [
        { text: 'plot(', changed: false },
        { text: 'x', changed: true },
        { text: ', "A")', changed: false },
      ],
      [
        { text: 'plot(', changed: false },
        { text: 'y', changed: true },
        { text: ', "A")', changed: false },
      ],
    ]);
  });

  it('folds unchanged runs away from the changes, keeping context', () => {
    const before = lines(40);
    const after = before.replace('line 20', 'line twenty');
    const blocks = collapseUnchanged(sideBySide(diffLines(before, after)), 3);
    expect(blocks.map((b) => b.kind)).toEqual(['gap', 'rows', 'gap']);
    const shown = blocks[1].rows;
    expect(shown.map((r) => r.left?.no)).toEqual([18, 19, 20, 21, 22, 23, 24]);
    expect(blocks[0].kind === 'gap' && blocks[0].rows.length).toBe(17);
    expect(blocks[2].kind === 'gap' && blocks[2].index).toBe(1);
  });

  it('short unchanged runs are not folded; identical texts fold into one gap', () => {
    const rows = sideBySide(diffLines('a\nb\nc\nd', 'A\nb\nc\nD'));
    expect(collapseUnchanged(rows, 1).map((b) => b.kind)).toEqual(['rows']);
    const same = collapseUnchanged(sideBySide(diffLines(lines(10), lines(10))));
    expect(same).toHaveLength(1);
    expect(same[0].kind).toBe('gap');
  });
});

describe('text-diff — inputs', () => {
  it('lists added, removed and changed overrides by id', () => {
    expect(
      diffInputValues(
        { 'MA::Fast': 9, 'MA::Slow': 21, Mode: 'A' },
        { 'MA::Fast': 12, Mode: 'A', 'Risk::ATR': 1.5 },
      ),
    ).toEqual([
      { id: 'MA::Fast', kind: 'changed', before: 9, after: 12 },
      { id: 'MA::Slow', kind: 'removed', before: 21 },
      { id: 'Risk::ATR', kind: 'added', after: 1.5 },
    ]);
    expect(diffInputValues(null, null)).toEqual([]);
    expect(diffInputValues({ a: 1.0 }, { a: 1 })).toEqual([]);
  });

  it('labels and values read plainly', () => {
    expect(inputLabel('Moving averages::Fast length')).toBe('Fast length');
    expect(inputLabel('len')).toBe('len');
    expect([formatInputValue(undefined), formatInputValue(true), formatInputValue('close')]).toEqual([
      '(default)',
      'true',
      'close',
    ]);
  });
});

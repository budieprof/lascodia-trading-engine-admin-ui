import { describe, expect, it } from 'vitest';
import { EditorState, Text, type RangeSet } from '@codemirror/state';
import type { GutterMarker } from '@codemirror/view';

import { heatTitle, profileHeat, profileHeatField, setProfileHeat } from './pine-profile-ext';

const SOURCE = '//@version=6\nindicator("x")\nfast = ta.ema(close, 9)\nslow = ta.ema(close, 21)\nplot(fast - slow)\n';
const PROFILE = [
  { line: 3, executions: 600, totalMicros: 1200 },
  { line: 4, executions: 600, totalMicros: 300 },
  { line: 5, executions: 600, totalMicros: 0 },
  // A library's line 3: not the script's line 3.
  { line: 3, executions: 600, totalMicros: 99_000, unit: 'me/lib/1' },
];

/** The 1-based lines that carry a mark. */
function markedLines(state: EditorState): number[] {
  const set: RangeSet<GutterMarker> = state.field(profileHeatField);
  const lines: number[] = [];
  set.between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number);
  });
  return lines;
}

function withHeat(doc = SOURCE, source: string | null = SOURCE): EditorState {
  const state = EditorState.create({ doc, extensions: [profileHeatField] });
  return state.update({ effects: setProfileHeat.of(profileHeat(state.doc, PROFILE, source)) }).state;
}

describe('profiler heat in the editor gutter (PE-I5)', () => {
  it('marks the script’s own lines that took time, hottest = 1', () => {
    const heat = profileHeat(Text.of(SOURCE.split('\n')), PROFILE, SOURCE);
    expect(heat.map((h) => [h.line, h.heat])).toEqual([
      [3, 1],
      [4, 0.25],
    ]);
    expect(heat[0].percent).toBeCloseTo(80);
    expect(markedLines(withHeat())).toEqual([3, 4]);
  });

  it('shows nothing for a profile of another text', () => {
    expect(markedLines(withHeat(SOURCE, SOURCE + '// edited\n'))).toEqual([]);
    expect(markedLines(withHeat(SOURCE, null))).toEqual([]);
  });

  it('keeps the marks on their lines through edits and drops a deleted line’s mark', () => {
    let state = withHeat();
    // Two lines inserted above: the marks move down with their lines.
    state = state.update({ changes: { from: 0, insert: '// a\n// b\n' } }).state;
    expect(markedLines(state)).toEqual([5, 6]);
    // The `fast` line (now line 5) deleted with its newline: only `slow` keeps a mark.
    const line = state.doc.line(5);
    state = state.update({ changes: { from: line.from - 1, to: line.to } }).state;
    expect(markedLines(state)).toEqual([5]);
  });

  it('clears the marks when the whole text is replaced or an empty profile arrives', () => {
    const replaced = withHeat().update({ changes: { from: 0, to: SOURCE.length, insert: 'other\nscript\n' } }).state;
    expect(markedLines(replaced)).toEqual([]);
    const cleared = withHeat().update({ effects: setProfileHeat.of([]) }).state;
    expect(markedLines(cleared)).toEqual([]);
  });

  it('describes a line in plain words', () => {
    expect(
      heatTitle({ line: 3, heat: 1, percent: 80, executions: 600, avgMicros: 2, totalMicros: 1200 }),
    ).toBe("Line 3: 80% of the script's run time, 1.20 ms in all — 600 execution(s), 2.0 µs each");
  });
});

import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';

import type { ScriptDiagnostic } from '@core/api/scripting.types';
import {
  callFrameText,
  editorFixes,
  fixRange,
  inLibrary,
  messageWithHint,
  shiftedFix,
  toEditorDiagnostics,
  unitLabel,
} from './pine-diagnostics';

// The engine's diagnostic hints, quick fixes, library units and runtime call stacks (runtime PR-I4)
// as the editor, the Problems panel and the preview show them.

const doc = Text.of(['//@version=6', 'indicator("x")', 'x = sma(close, 14)', 'plot(x)']);

const d = (partial: Partial<ScriptDiagnostic>): ScriptDiagnostic => ({
  code: 'PS2008',
  severity: 'error',
  message: "Could not find function or function reference 'sma'.",
  line: 3,
  column: 5,
  endLine: 3,
  endColumn: 8,
  ...partial,
});

const smaFix = {
  title: "Change to 'ta.sma'",
  line: 3,
  column: 5,
  endLine: 3,
  endColumn: 8,
  replacement: 'ta.sma',
};

describe('diagnostic hints and quick fixes', () => {
  it('shows the hint under the message on the marker', () => {
    const [m] = toEditorDiagnostics(doc, [
      d({ hint: "Since Pine v5 'sma' is in the 'ta' namespace: 'ta.sma'." }),
    ]);
    expect(m.message).toBe(
      "Could not find function or function reference 'sma'.\nSince Pine v5 'sma' is in the 'ta' namespace: 'ta.sma'.",
    );
    expect(messageWithHint({ message: 'm', hint: '  ' })).toBe('m');
    expect(messageWithHint({ message: 'm', hint: null })).toBe('m');
  });

  it('maps every quick fix onto the text it replaces', () => {
    const [m] = toEditorDiagnostics(doc, [d({ fixes: [smaFix] })]);
    expect(m.fixes).toHaveLength(1);
    const [fix] = m.fixes;
    expect(fix.title).toBe("Change to 'ta.sma'");
    expect(doc.sliceString(fix.from, fix.to)).toBe('sma');
    expect(fix.insert).toBe('ta.sma');
  });

  it('maps an insertion (an empty range) and clamps positions past the document', () => {
    const insert = fixRange(doc, {
      ...smaFix,
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 1,
      replacement: '//@version=6\n',
    });
    expect(insert).toEqual({ from: 0, to: 0 });
    const past = fixRange(doc, { ...smaFix, line: 40, column: 90, endLine: 41, endColumn: 99 });
    expect(past!.from).toBeLessThanOrEqual(doc.length);
    expect(past!.to).toBeLessThanOrEqual(doc.length);
    expect(fixRange(Text.empty, smaFix)).toEqual({ from: 0, to: 0 });
  });

  it('leaves out malformed fixes and has none for a diagnostic without any', () => {
    const malformed = { ...smaFix, replacement: undefined as unknown as string };
    expect(editorFixes(doc, d({ fixes: [malformed, smaFix] }))).toHaveLength(1);
    expect(editorFixes(doc, d({}))).toEqual([]);
    expect(editorFixes(doc, d({ fixes: null }))).toEqual([]);
  });
});

describe('library diagnostics', () => {
  const library = d({
    unit: 'alice/tools/2',
    line: 2,
    column: 1,
    endLine: 2,
    endColumn: 4,
    fixes: [smaFix],
  });

  it('never places a library diagnostic on the script’s own lines', () => {
    expect(inLibrary(library)).toBe(true);
    expect(inLibrary(d({}))).toBe(false);
    expect(inLibrary(d({ unit: ' ' }))).toBe(false);
    const markers = toEditorDiagnostics(doc, [library, d({})]);
    expect(markers).toHaveLength(1);
    expect(doc.sliceString(markers[0].from, markers[0].to)).toBe('sma');
  });

  it('offers no quick fix for library code (it is not in this editor)', () => {
    expect(editorFixes(doc, library)).toEqual([]);
  });

  it('names the library in plain words', () => {
    expect(unitLabel('alice/tools/2')).toBe('library alice/tools/2');
    expect(unitLabel(null)).toBeNull();
    expect(unitLabel('')).toBeNull();
  });
});

describe('quick fixes after an edit', () => {
  const marker = { from: 20, to: 23 };
  const fix = { from: 20, to: 23 };

  it('applies the fix where it was computed while the text is unchanged', () => {
    expect(shiftedFix(marker, fix, 20, 23, true)).toEqual({ from: 20, to: 23 });
  });

  it('moves the fix with its marker when text before it changed', () => {
    expect(shiftedFix(marker, fix, 25, 28, false)).toEqual({ from: 25, to: 28 });
    expect(shiftedFix(marker, { from: 20, to: 20 }, 17, 20, false)).toEqual({ from: 17, to: 17 });
  });

  it('refuses when the marker itself was edited or the fix is elsewhere', () => {
    expect(shiftedFix(marker, fix, 25, 30, false)).toBeNull();
    expect(shiftedFix(marker, { from: 40, to: 44 }, 25, 28, false)).toBeNull();
  });
});

describe('runtime error call stacks', () => {
  it('describes each frame in plain words', () => {
    expect(callFrameText({ function: 'stopLevel', line: 12, column: 5, unit: null })).toBe(
      'in stopLevel(), called on line 12',
    );
    expect(callFrameText({ function: 'atrBracket', line: 40, unit: 'lascodia/classic/1' })).toBe(
      'in atrBracket(), called on line 40 in library lascodia/classic/1',
    );
    expect(callFrameText({ function: 'f', line: null })).toBe('in f(), called from the script');
  });
});

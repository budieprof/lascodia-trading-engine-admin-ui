import type {
  ScriptDiagnostic,
  ScriptDiagnosticFix,
  ScriptDiagnosticSeverity,
  ScriptRuntimeError,
} from '@core/api/scripting.types';

/** The slice of a CodeMirror `Text` the mapping needs. */
export interface DocLike {
  readonly lines: number;
  line(n: number): { from: number; to: number; text: string };
}

/** A quick fix as editor offsets: replace [from, to) with `insert`. */
export interface EditorFix {
  title: string;
  from: number;
  to: number;
  insert: string;
}

/** A diagnostic as editor offsets — the shape of a CodeMirror lint `Diagnostic`. */
export interface EditorDiagnostic {
  from: number;
  to: number;
  severity: 'error' | 'warning' | 'info';
  /** The engine's message, with its hint on a line of its own when it has one. */
  message: string;
  /** The stable code (`PS2003`), shown as the diagnostic's source. */
  source: string;
  /** The engine's quick fixes, offered as the marker's actions. */
  fixes: EditorFix[];
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * True for a diagnostic located in an imported library's code (`unit` = `publisher/name/version`):
 * its line numbers are the library's, not the script's, so it is never placed on the script's lines.
 */
export function inLibrary(d: { unit?: string | null }): boolean {
  return typeof d.unit === 'string' && d.unit.trim() !== '';
}

/** "library publisher/name/version" for a location in an imported library; null for the script's own code. */
export function unitLabel(unit: string | null | undefined): string | null {
  return typeof unit === 'string' && unit.trim() !== '' ? `library ${unit.trim()}` : null;
}

/** The engine's message with its hint, as the editor's marker shows it. */
export function messageWithHint(d: Pick<ScriptDiagnostic, 'message' | 'hint'>): string {
  const hint = typeof d.hint === 'string' ? d.hint.trim() : '';
  return hint ? `${d.message}\n${hint}` : d.message;
}

/**
 * A quick fix's 1-based line/column range (end column exclusive) as document offsets, clamped to
 * the document. Null when the document is empty.
 */
export function fixRange(
  doc: DocLike,
  fix: ScriptDiagnosticFix,
): { from: number; to: number } | null {
  if (doc.lines === 0) return null;
  const lineNo = clamp(Math.trunc(fix.line || 1), 1, doc.lines);
  const line = doc.line(lineNo);
  const from = line.from + clamp(Math.trunc(fix.column || 1) - 1, 0, line.text.length);
  const endLineNo = clamp(Math.trunc(fix.endLine || lineNo), lineNo, doc.lines);
  const endLine = doc.line(endLineNo);
  const to =
    endLine.from + clamp(Math.trunc(fix.endColumn || fix.column || 1) - 1, 0, endLine.text.length);
  return { from, to: Math.max(from, to) };
}

/** The diagnostic's quick fixes as editor edits (fixes without a title or a replacement are left out). */
export function editorFixes(doc: DocLike, d: ScriptDiagnostic): EditorFix[] {
  if (inLibrary(d) || !Array.isArray(d.fixes)) return [];
  const out: EditorFix[] = [];
  for (const fix of d.fixes) {
    if (!fix || typeof fix.title !== 'string' || typeof fix.replacement !== 'string') continue;
    const range = fixRange(doc, fix);
    if (range) out.push({ title: fix.title, ...range, insert: fix.replacement });
  }
  return out;
}

/**
 * Where a quick fix lands once the text has changed since the markers were set: CodeMirror maps the
 * marker (its `from`/`to` now) but not the fix, so the fix moves with its marker while the marker kept
 * its length and the fix touches it. A fix elsewhere after an edit is not applied (null): its
 * position may no longer be the text it was computed for — the next compile offers it again.
 */
export function shiftedFix(
  d: Pick<EditorDiagnostic, 'from' | 'to'>,
  fix: { from: number; to: number },
  from: number,
  to: number,
  unchanged: boolean,
): { from: number; to: number } | null {
  if (unchanged) return { from: fix.from, to: fix.to };
  if (to - from !== d.to - d.from) return null;
  if (fix.to < d.from || fix.from > d.to) return null;
  const shift = from - d.from;
  return { from: fix.from + shift, to: fix.to + shift };
}

/**
 * One frame of a runtime error's call stack, in plain words: "in f(), called on line 12" (or
 * "… in library publisher/name/version" when the call is written in a library).
 */
export function callFrameText(frame: NonNullable<ScriptRuntimeError['callStack']>[number]): string {
  const where = frame.line ? `called on line ${frame.line}` : 'called from the script';
  const lib = unitLabel(frame.unit);
  return `in ${frame.function}(), ${where}${lib ? ` in ${lib}` : ''}`;
}

/**
 * Maps the engine's 1-based line/column diagnostics onto document offsets. The end column is
 * exclusive; positions past the document (the source changed since the compile) are clamped, and
 * an empty range is widened to the word at its start so it can be seen and hovered. Diagnostics in
 * an imported library's code are left out: their lines are the library's (the Problems panel lists
 * them with the library's name).
 */
export function toEditorDiagnostics(
  doc: DocLike,
  diagnostics: readonly ScriptDiagnostic[],
): EditorDiagnostic[] {
  const out: EditorDiagnostic[] = [];
  for (const d of diagnostics) {
    if (doc.lines === 0) break;
    if (inLibrary(d)) continue;
    const lineNo = clamp(Math.trunc(d.line || 1), 1, doc.lines);
    const line = doc.line(lineNo);
    const col = clamp(Math.trunc(d.column || 1) - 1, 0, line.text.length);
    let from = line.from + col;
    const endLineNo = clamp(Math.trunc(d.endLine || lineNo), lineNo, doc.lines);
    const endLine = doc.line(endLineNo);
    const endCol = clamp(Math.trunc(d.endColumn || d.column || 1) - 1, 0, endLine.text.length);
    let to = Math.max(from, endLine.from + endCol);
    if (to === from) {
      const word = /^[A-Za-z0-9_.]+/.exec(line.text.slice(col));
      if (word) to = from + word[0].length;
      else if (col < line.text.length) to = from + 1;
      else if (col > 0) from -= 1;
    }
    out.push({
      from,
      to,
      severity: severityOf(d.severity),
      message: messageWithHint(d),
      source: d.code,
      fixes: editorFixes(doc, d),
    });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

function severityOf(s: ScriptDiagnosticSeverity | string): EditorDiagnostic['severity'] {
  return s === 'warning' || s === 'info' ? s : 'error';
}

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export function countDiagnostics(diagnostics: readonly ScriptDiagnostic[]): DiagnosticCounts {
  const c: DiagnosticCounts = { errors: 0, warnings: 0, infos: 0 };
  for (const d of diagnostics) {
    if (d.severity === 'warning') c.warnings++;
    else if (d.severity === 'info') c.infos++;
    else c.errors++;
  }
  return c;
}

/** Diagnostics in reading order (line, column), errors first on the same position. */
export function sortDiagnostics(diagnostics: readonly ScriptDiagnostic[]): ScriptDiagnostic[] {
  const rank = (s: string) => (s === 'error' ? 0 : s === 'warning' ? 1 : 2);
  return [...diagnostics].sort(
    (a, b) => a.line - b.line || a.column - b.column || rank(a.severity) - rank(b.severity),
  );
}

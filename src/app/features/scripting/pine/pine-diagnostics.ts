import type { ScriptDiagnostic, ScriptDiagnosticSeverity } from '@core/api/scripting.types';

/** The slice of a CodeMirror `Text` the mapping needs. */
export interface DocLike {
  readonly lines: number;
  line(n: number): { from: number; to: number; text: string };
}

/** A diagnostic as editor offsets — the shape of a CodeMirror lint `Diagnostic`. */
export interface EditorDiagnostic {
  from: number;
  to: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** The stable code (`PS2003`), shown as the diagnostic's source. */
  source: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Maps the engine's 1-based line/column diagnostics onto document offsets. The end column is
 * exclusive; positions past the document (the source changed since the compile) are clamped, and
 * an empty range is widened to the word at its start so it can be seen and hovered.
 */
export function toEditorDiagnostics(doc: DocLike, diagnostics: readonly ScriptDiagnostic[]): EditorDiagnostic[] {
  const out: EditorDiagnostic[] = [];
  for (const d of diagnostics) {
    if (doc.lines === 0) break;
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
      message: d.message,
      source: d.code,
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

import { indentWidth, maskCommentsAndStrings } from './pine-scan';

/**
 * Pine v6 indentation and folding rules, as pure functions over lines of text.
 *
 * Pine's blocks are indentation-defined: a local block is indented by four spaces (or a tab)
 * relative to its header, and a WRAPPED line must not be indented by a multiple of four unless it
 * sits inside parentheses — otherwise the compiler reads it as a new local block. So:
 *
 * - after a block header (`if`, `else`, `for`, `while`, `switch`, `type`, `enum`, a line ending
 *   in `=>`, or `x = if …`) the next line goes one level deeper;
 * - inside open brackets a wrapped line goes one level deeper (any indent is legal there);
 * - after a line ending in an operator or comma, the wrapped line goes TWO columns deeper, which is
 *   never a multiple of four;
 * - once a wrapped statement is complete, the next line returns to the statement's indentation;
 * - `else` aligns with its `if`, and a lone `)` / `]` with the statement it closes.
 */

export const PINE_INDENT_UNIT = 4;
const CONTINUATION = 2;

/** Lines are looked at through a callback so CodeMirror documents need not be copied. */
export type LineReader = (index: number) => string;

/** True when the statement whose FIRST line this is opens a local block. */
export function opensBlockHeader(maskedFirstLine: string): boolean {
  const t = maskedFirstLine.trim();
  if (!t) return false;
  if (/^(?:export\s+)?(?:type|enum)\s+[A-Za-z_]\w*$/.test(t)) return true;
  if (/^else\b/.test(t)) return true;
  if (/^(?:if|while|for|switch|once)\b/.test(t)) return true;
  // `x = if …`, `[a, b] = switch …`, `var y = for …` — structures used as expressions.
  return /(?:^|[^=!<>:])(?::=|=)\s*(?:if|switch|for|while)\b/.test(t);
}

/** True when the line's code (masked) ends in something that must continue on the next line. */
export function endsWithContinuation(maskedLine: string): boolean {
  const t = maskedLine.trimEnd();
  if (!t.trim() || /=>$/.test(t)) return false;
  return /(?:[+\-*/%,?:=<>]|\band|\bor|\bnot)$/.test(t);
}

function bracketDelta(maskedLine: string): number {
  let d = 0;
  for (const ch of maskedLine) {
    if (ch === '(' || ch === '[') d++;
    else if (ch === ')' || ch === ']') d--;
  }
  return d;
}

interface StatementState {
  /** First line of the statement that `line` belongs to. */
  start: number;
  /** Bracket depth after `line`. */
  depth: number;
  /** The statement continues on the line after `line`. */
  continues: boolean;
}

/**
 * Walks forward from a safe starting point to `line`, tracking where each statement starts and
 * the bracket depth. A safe start is a column-0 line not preceded by an open continuation; the
 * walk is capped so pathological documents stay fast.
 */
function statementAt(
  read: LineReader,
  line: number,
  maskLine: (i: number) => string,
): StatementState {
  let from = line;
  const floor = Math.max(0, line - 400);
  while (from > floor) {
    const m = maskLine(from);
    if (m.trim() && indentWidth(m) === 0) {
      const p = prevNonBlank(read, from - 1);
      if (p < 0 || !endsWithContinuation(maskLine(p))) break;
    }
    from--;
  }
  let start = from;
  let depth = 0;
  let continues = false;
  for (let i = from; i <= line; i++) {
    const m = maskLine(i);
    if (!m.trim()) continue;
    if (depth === 0 && !continues) start = i;
    depth = Math.max(0, depth + bracketDelta(m));
    continues = depth > 0 || endsWithContinuation(m);
  }
  return { start, depth, continues };
}

function prevNonBlank(read: LineReader, from: number): number {
  for (let i = from; i >= 0; i--) if (read(i).trim()) return i;
  return -1;
}

/**
 * The indentation (in columns) the 0-based `line` should have, given the lines above it. The
 * line's own text only matters for `else` and closing brackets, which dedent.
 */
export function computePineIndent(read: LineReader, line: number): number {
  const cache = new Map<number, string>();
  const maskLine = (i: number): string => {
    let m = cache.get(i);
    if (m === undefined) {
      m = maskCommentsAndStrings(read(i));
      cache.set(i, m);
    }
    return m;
  };
  const prev = prevNonBlank(read, line - 1);
  if (prev < 0) return 0;
  const own = maskLine(line).trim();
  const st = statementAt(read, prev, maskLine);
  const stmtIndent = indentWidth(read(st.start));

  if (st.continues) {
    if (st.depth > 0 && /^[)\]]/.test(own)) return stmtIndent;
    if (prev !== st.start) return indentWidth(read(prev));
    return stmtIndent + (st.depth > 0 ? PINE_INDENT_UNIT : CONTINUATION);
  }

  const opens = opensBlockHeader(maskLine(st.start)) || /=>\s*$/.test(maskLine(prev).trimEnd());
  let indent = opens ? stmtIndent + PINE_INDENT_UNIT : stmtIndent;

  if (/^else\b/.test(own)) {
    // Align with the `if` (or `else if`) that owns this branch.
    for (let i = line - 1; i >= 0; i--) {
      const m = maskLine(i);
      if (!m.trim()) continue;
      const w = indentWidth(read(i));
      if (w < indent && /^(?:if\b|else\b)|(?::=|=)\s*if\b/.test(m.trim())) {
        const owner = statementAt(read, i, maskLine);
        return indentWidth(read(owner.start));
      }
      if (w === 0 && !/^(?:if\b|else\b)/.test(m.trim())) break;
    }
    indent = Math.max(0, indent - PINE_INDENT_UNIT);
  }
  return indent;
}

/**
 * The foldable range starting on `line`, as the last 0-based line to fold through, or null.
 * `//#region` folds to its matching `//#endregion`; any other line folds the more-indented lines
 * that follow it.
 */
export function pineFoldEnd(read: LineReader, lineCount: number, line: number): number | null {
  const text = read(line);
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^\/\/\s*#region\b/.test(trimmed)) {
    let depth = 0;
    for (let i = line + 1; i < lineCount; i++) {
      const t = read(i).trim();
      if (/^\/\/\s*#region\b/.test(t)) depth++;
      else if (/^\/\/\s*#endregion\b/.test(t)) {
        if (depth === 0) return i;
        depth--;
      }
    }
    return null;
  }
  if (trimmed.startsWith('//')) return null;
  const base = indentWidth(text);
  let end = -1;
  for (let i = line + 1; i < lineCount; i++) {
    const t = read(i);
    if (!t.trim()) continue;
    if (indentWidth(t) <= base) break;
    end = i;
  }
  return end > line ? end : null;
}

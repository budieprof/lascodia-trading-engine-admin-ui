/**
 * Lightweight, parser-free reading of Pine v6 source for the editor: masking comments and strings,
 * collecting the user's own declarations (variables, functions, methods, types, enums, imports)
 * and locating the call around the cursor. The engine's compiler is the authority on meaning —
 * this only has to be good enough to drive completion, signature help and hover while typing,
 * including on code that does not compile yet.
 */

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
/** A type expression: `float`, `chart.point`, `array<float>`, `map<string, array<int>>`, `MyType`, `float[]`. */
const TYPE_EXPR = `${IDENT}(?:\\.${IDENT})*(?:\\s*<[^<>=()]*(?:<[^<>=()]*>[^<>=()]*)*>)?(?:\\[\\])?`;

const IMPORT_RE =
  /^import\s+([A-Za-z0-9_-]+)\s*\/\s*([A-Za-z0-9_-]+)\s*\/\s*(\d+)(?:\s+as\s+([A-Za-z_]\w*))?/;
const TYPE_DECL_RE = /^(export\s+)?type\s+([A-Za-z_]\w*)\s*$/;
const ENUM_DECL_RE = /^(export\s+)?enum\s+([A-Za-z_]\w*)\s*$/;
const METHOD_HEAD_RE = /^(export\s+)?method\s+([A-Za-z_]\w*)\s*\(/;
const FUNC_HEAD_RE = /^(export\s+)?([A-Za-z_]\w*)\s*\(/;
const VAR_DECL_RE = new RegExp(
  `^(export\\s+)?(?:(var|varip)\\s+)?(?:(const|simple|series)\\s+)?(?:(${TYPE_EXPR})\\s+)?(${IDENT})\\s*=(?![=>])`,
);
const TUPLE_DECL_RE = /^\[([^\]]*)\]\s*=(?![=>])/;
const FOR_RE = /^for\s+([A-Za-z_]\w*)\s*=(?!=)/;
const FOR_IN_RE = /^for\s+(?:\[([^\]]*)\]|([A-Za-z_]\w*))\s+in\b/;
const PARAM_RE = new RegExp(
  `^(?:(const|simple|series)\\s+)?(?:(${TYPE_EXPR})\\s+)?(${IDENT})\\s*(?:=\\s*([\\s\\S]*))?$`,
);
const FIELD_RE = new RegExp(`^(?:(varip)\\s+)?(${TYPE_EXPR})\\s+(${IDENT})\\s*(?:=\\s*(.*))?$`);
const ENUM_MEMBER_RE = /^([A-Za-z_]\w*)\s*(?:=\s*(.*))?$/;

/** Words that can precede `(` without being a call. */
const NON_CALL_WORDS = new Set([
  'if',
  'else',
  'while',
  'for',
  'switch',
  'and',
  'or',
  'not',
  'in',
  'to',
  'by',
  'return',
  'once',
]);

const RESERVED = new Set([
  'if',
  'else',
  'switch',
  'for',
  'to',
  'by',
  'in',
  'while',
  'break',
  'continue',
  'var',
  'varip',
  'import',
  'export',
  'as',
  'enum',
  'type',
  'method',
  'and',
  'or',
  'not',
  'true',
  'false',
  'na',
  'const',
  'simple',
  'series',
  'once',
]);

// ── Comments and strings ───────────────────────────────────────────────────

export interface LexicalRange {
  /** Offset of `//` or of the opening quote(s). */
  from: number;
  /** Offset just past the comment's last character, or past the closing quote(s). */
  to: number;
  kind: 'comment' | 'string';
  /** Width of the string delimiter (1, or 3 for `"""`). */
  quote: number;
  /** False for a string still being typed (no closing quote yet). */
  closed: boolean;
}

/** Every comment and string literal, in order. */
export function lexicalRanges(text: string): LexicalRange[] {
  const out: LexicalRange[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const from = i;
      while (i < n && text[i] !== '\n') i++;
      out.push({ from, to: i, kind: 'comment', quote: 0, closed: true });
      continue;
    }
    if ((c === '"' || c === "'") && text[i + 1] === c && text[i + 2] === c) {
      const from = i;
      const end = text.indexOf(c + c + c, i + 3);
      i = end < 0 ? n : end + 3;
      out.push({ from, to: i, kind: 'string', quote: 3, closed: end >= 0 });
      continue;
    }
    if (c === '"' || c === "'") {
      const from = i++;
      let closed = false;
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\' && text[i + 1] !== '\n') {
          i += 2;
          continue;
        }
        if (text[i++] === c) {
          closed = true;
          break;
        }
      }
      out.push({ from, to: Math.min(i, n), kind: 'string', quote: 1, closed });
      continue;
    }
    i++;
  }
  return out;
}

/** True when a cursor at `pos` is inside a comment or between a string's quotes. */
export function isInCommentOrString(ranges: readonly LexicalRange[], pos: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].from < pos) {
      hit = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (hit < 0) return false;
  const r = ranges[hit];
  if (r.kind === 'comment') return pos <= r.to;
  return r.closed ? pos <= r.to - r.quote && pos >= r.from + r.quote : pos <= r.to;
}

/**
 * The text with every comment and the contents of every string replaced by spaces (newlines and
 * string delimiters kept), so structural scans never see brackets, commas or `=>` inside them.
 * Offsets are unchanged.
 */
export function maskCommentsAndStrings(text: string, ranges = lexicalRanges(text)): string {
  if (ranges.length === 0) return text;
  const out = text.split('');
  for (const r of ranges) {
    const from = r.kind === 'comment' ? r.from : r.from + r.quote;
    const to = r.kind === 'comment' || !r.closed ? r.to : r.to - r.quote;
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ';
  }
  return out.join('');
}

/** Leading whitespace width (a tab counts as four columns). */
export function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w++;
    else if (ch === '\t') w += 4 - (w % 4);
    else break;
  }
  return w;
}

// ── Declarations ───────────────────────────────────────────────────────────

export interface PineParam {
  name: string;
  type?: string;
  qualifier?: string;
  defaultText?: string;
}

export interface PineFunctionSymbol {
  kind: 'function' | 'method';
  name: string;
  params: PineParam[];
  /** 0-based line of the header. */
  line: number;
  /** Last 0-based line of the body. */
  endLine: number;
  exported: boolean;
  doc?: string;
  paramDocs?: Record<string, string>;
  returnsDoc?: string;
  /** Methods: the type of the first parameter (the receiver). */
  receiverType?: string;
  /** Single-line body text, when the function is `f(x) => expr`. */
  body?: string;
}

export interface PineVariableSymbol {
  kind: 'variable';
  name: string;
  /** Explicit type, or one inferred from a literal / constructor on the right-hand side. */
  type?: string;
  qualifier?: string;
  declKeyword?: 'var' | 'varip';
  line: number;
  indent: number;
  /** Last 0-based line where the variable is in scope. */
  scopeEnd: number;
  exported?: boolean;
  doc?: string;
  /** Callee of the initialiser when it is a call, e.g. `ta.ema` — lets the catalog supply a type. */
  initCallee?: string;
  /** Right-hand side as written (first line only). */
  initText?: string;
  /** Declared as a function parameter / loop variable rather than with `=`. */
  role?: 'param' | 'loop';
}

export interface PineTypeField {
  name: string;
  type?: string;
  defaultText?: string;
  doc?: string;
  varip?: boolean;
}

export interface PineTypeSymbol {
  kind: 'type';
  name: string;
  fields: PineTypeField[];
  line: number;
  exported: boolean;
  doc?: string;
}

export interface PineEnumMember {
  name: string;
  title?: string;
  doc?: string;
}

export interface PineEnumSymbol {
  kind: 'enum';
  name: string;
  members: PineEnumMember[];
  line: number;
  exported: boolean;
  doc?: string;
}

export interface PineImportSymbol {
  kind: 'import';
  alias: string;
  publisher: string;
  libraryName: string;
  version: number;
  line: number;
}

export interface PineDocSymbols {
  functions: PineFunctionSymbol[];
  methods: PineFunctionSymbol[];
  variables: PineVariableSymbol[];
  types: PineTypeSymbol[];
  enums: PineEnumSymbol[];
  imports: PineImportSymbol[];
}

export const EMPTY_SYMBOLS: PineDocSymbols = {
  functions: [],
  methods: [],
  variables: [],
  types: [],
  enums: [],
  imports: [],
};

interface DocBlock {
  doc?: string;
  params: Record<string, string>;
  fields: Record<string, string>;
  returns?: string;
}

/** Reads the `//@function` / `//@param` / … annotation block ending right above `line`. */
function readDocBlock(lines: string[], line: number): DocBlock {
  const block: DocBlock = { params: {}, fields: {} };
  let start = line;
  while (start > 0 && lines[start - 1].trim().startsWith('//')) start--;
  let target: { kind: 'doc' | 'param' | 'field' | 'returns'; key?: string } | null = null;
  const append = (text: string): void => {
    if (!target || !text) return;
    const add = (prev: string | undefined) => (prev ? `${prev} ${text}` : text);
    if (target.kind === 'doc') block.doc = add(block.doc);
    else if (target.kind === 'returns') block.returns = add(block.returns);
    else if (target.kind === 'param' && target.key)
      block.params[target.key] = add(block.params[target.key]);
    else if (target.kind === 'field' && target.key)
      block.fields[target.key] = add(block.fields[target.key]);
  };
  for (let i = start; i < line; i++) {
    const body = lines[i].trim().replace(/^\/\/\s?/, '');
    const m = /^@(\w+)=?\s*(.*)$/.exec(body.trim());
    if (m) {
      const [, tag, rest] = m;
      if (tag === 'param' || tag === 'field') {
        const pm = /^([A-Za-z_]\w*)\s*(.*)$/.exec(rest);
        target = { kind: tag, key: pm?.[1] };
        append(pm?.[2]?.trim() ?? '');
      } else if (tag === 'returns') {
        target = { kind: 'returns' };
        append(rest.trim());
      } else if (
        tag === 'function' ||
        tag === 'variable' ||
        tag === 'type' ||
        tag === 'enum' ||
        tag === 'description'
      ) {
        target = { kind: 'doc' };
        append(rest.trim());
      } else {
        target = null;
      }
    } else if (!body.startsWith('#')) {
      append(body.trim());
    }
  }
  return block;
}

const GENERIC_RE =
  /^<\s*[A-Za-z_][\w.]*(?:\s*<[^<>]*>)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s*<[^<>]*>)?)?\s*>/;

/**
 * End index of a generic argument list (`<float>`, `<string, array<int>>`) starting at `i`, or -1
 * when the `<` there is a comparison. A generic `<` follows an identifier with no space.
 */
function genericEnd(text: string, i: number): number {
  if (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1])) return -1;
  const m = GENERIC_RE.exec(text.slice(i, i + 120));
  return m ? i + m[0].length - 1 : -1;
}

/** Splits `a, b = f(x, y), c` at top-level commas (generic `<…>` lists included). Masked text. */
export function splitTopLevel(text: string, sep = ','): { text: string; start: number }[] {
  const parts: { text: string; start: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<') {
      const end = genericEnd(text, i);
      if (end > 0) i = end;
    } else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      parts.push({ text: text.slice(start, i), start });
      start = i + 1;
    }
  }
  parts.push({ text: text.slice(start), start });
  return parts;
}

/** Index of the `)` matching the `(` at `open`, or -1 (gives up after `limit` characters). */
function matchParen(masked: string, open: number, limit = 6000): number {
  let depth = 0;
  const stop = Math.min(masked.length, open + limit);
  for (let i = open; i < stop; i++) {
    const c = masked[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') {
      depth--;
      if (depth === 0) return c === ')' ? i : -1;
    }
  }
  return -1;
}

function parseParams(maskedList: string, originalList: string): PineParam[] {
  if (!maskedList.trim()) return [];
  return splitTopLevel(maskedList)
    .map(({ text, start }) => {
      const original = originalList.slice(start, start + text.length);
      const m = PARAM_RE.exec(text.trim());
      if (!m) return null;
      const [, qualifier, type, name] = m;
      const eq = text.indexOf('=');
      const defaultText = m[4] !== undefined && eq >= 0 ? original.slice(eq + 1).trim() : undefined;
      return {
        name,
        ...(type ? { type: type.replace(/\s+/g, ' ') } : {}),
        ...(qualifier ? { qualifier } : {}),
        ...(defaultText ? { defaultText } : {}),
      } as PineParam;
    })
    .filter((p): p is PineParam => !!p);
}

/** The type of a literal or constructor-call initialiser, when it is evident from the text. */
export function inferInitType(rhs: string): { type?: string; callee?: string } {
  const t = rhs.trim();
  if (!t) return {};
  if (/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/.test(t)) return { type: 'color' };
  if (/^["']/.test(t)) return { type: 'string' };
  if (/^(?:true|false)\b/.test(t)) return { type: 'bool' };
  if (/^-?\d+\.\d*(?:[eE][+-]?\d+)?\b|^-?\.\d+/.test(t)) return { type: 'float' };
  if (/^-?\d+(?:[eE][+-]?\d+)?\b/.test(t)) return { type: /[eE]/.test(t) ? 'float' : 'int' };
  const call = /^([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*(<([^()]*)>)?\s*\(/.exec(t);
  if (!call) return {};
  const callee = call[1];
  const generic = call[3]?.replace(/\s+/g, ' ').trim();
  const collection = /^(array|matrix|map)\.(new|from)(?:_(\w+))?$/.exec(callee);
  if (collection) {
    const [, kind, , suffix] = collection;
    const element = generic ?? suffix;
    return { type: element ? `${kind}<${element}>` : kind, callee };
  }
  const drawing = /^(line|label|box|table|polyline|linefill)\.(new|copy)$/.exec(callee);
  if (drawing) return { type: drawing[1], callee };
  if (/^chart\.point\.(new|from_index|from_time|now|copy)$/.test(callee))
    return { type: 'chart.point', callee };
  const udt = /^([A-Za-z_]\w*)\.(new|copy)$/.exec(callee);
  if (udt && !['str', 'math', 'ta', 'color', 'request', 'input'].includes(udt[1]))
    return { type: udt[1], callee };
  const inputs: Record<string, string> = {
    'input.int': 'int',
    'input.float': 'float',
    'input.price': 'float',
    'input.source': 'float',
    'input.bool': 'bool',
    'input.color': 'color',
    'input.string': 'string',
    'input.text_area': 'string',
    'input.timeframe': 'string',
    'input.symbol': 'string',
    'input.session': 'string',
    'input.time': 'int',
  };
  if (inputs[callee]) return { type: inputs[callee], callee };
  if (callee === 'input.enum') {
    const em = /^input\.enum\s*\(\s*([A-Za-z_]\w*)\./.exec(t);
    return { type: em?.[1], callee };
  }
  if (callee === 'color.new' || callee === 'color.rgb' || callee === 'color.from_gradient')
    return { type: 'color', callee };
  if (callee.startsWith('str.') && callee !== 'str.length' && !callee.startsWith('str.pos'))
    return { callee };
  return { callee };
}

/** End line (inclusive) of the block whose header is `line` at indentation `indent`. */
function blockEnd(lines: string[], masked: string[], line: number, indent: number): number {
  let end = line;
  for (let i = line + 1; i < lines.length; i++) {
    if (!masked[i].trim()) continue;
    if (indentWidth(lines[i]) <= indent) break;
    end = i;
  }
  return end;
}

/**
 * Collects the user's declarations. Local variables carry the last line of their scope so
 * completion only offers them where they are visible.
 */
export function scanPineSymbols(text: string): PineDocSymbols {
  const lines = text.split('\n');
  const maskedText = maskCommentsAndStrings(text);
  const masked = maskedText.split('\n');
  const lineStarts: number[] = [];
  {
    let off = 0;
    for (const l of lines) {
      lineStarts.push(off);
      off += l.length + 1;
    }
  }
  const out: PineDocSymbols = {
    functions: [],
    methods: [],
    variables: [],
    types: [],
    enums: [],
    imports: [],
  };

  // Bracket depth at the start of each line: a line that starts inside an open `(`/`[` is a
  // wrapped argument list (`title = "x",`), never a declaration.
  const depthAtStart: number[] = [];
  {
    let depth = 0;
    for (const m of masked) {
      depthAtStart.push(depth);
      for (const ch of m) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const m = masked[i];
    const trimmed = m.trim();
    if (!trimmed || depthAtStart[i] > 0) continue;
    const indent = indentWidth(m);
    const lead = m.length - m.trimStart().length;
    const original = lines[i];

    if (indent === 0) {
      const imp = IMPORT_RE.exec(trimmed);
      if (imp) {
        out.imports.push({
          kind: 'import',
          publisher: imp[1],
          libraryName: imp[2],
          version: Number(imp[3]),
          alias: imp[4] ?? imp[2],
          line: i,
        });
        continue;
      }
      const td = TYPE_DECL_RE.exec(trimmed);
      if (td) {
        const docs = readDocBlock(lines, i);
        const sym: PineTypeSymbol = {
          kind: 'type',
          name: td[2],
          fields: [],
          line: i,
          exported: !!td[1],
          ...(docs.doc ? { doc: docs.doc } : {}),
        };
        const end = blockEnd(lines, masked, i, 0);
        for (let j = i + 1; j <= end; j++) {
          const fm = masked[j].trim();
          if (!fm) continue;
          const f = FIELD_RE.exec(fm);
          if (!f) continue;
          const fieldLead = masked[j].length - masked[j].trimStart().length;
          const eq = masked[j].indexOf('=', fieldLead);
          sym.fields.push({
            name: f[3],
            type: f[2].replace(/\s+/g, ' '),
            ...(f[1] ? { varip: true } : {}),
            ...(f[4] !== undefined && eq >= 0
              ? {
                  defaultText: lines[j]
                    .slice(eq + 1)
                    .split('//')[0]
                    .trim(),
                }
              : {}),
            ...(docs.fields[f[3]] ? { doc: docs.fields[f[3]] } : {}),
          });
        }
        out.types.push(sym);
        i = end;
        continue;
      }
      const ed = ENUM_DECL_RE.exec(trimmed);
      if (ed) {
        const docs = readDocBlock(lines, i);
        const sym: PineEnumSymbol = {
          kind: 'enum',
          name: ed[2],
          members: [],
          line: i,
          exported: !!ed[1],
          ...(docs.doc ? { doc: docs.doc } : {}),
        };
        const end = blockEnd(lines, masked, i, 0);
        for (let j = i + 1; j <= end; j++) {
          const mm = ENUM_MEMBER_RE.exec(masked[j].trim());
          if (!mm) continue;
          const titleMatch = /=\s*(["'])(.*?)\1/.exec(lines[j]);
          sym.members.push({
            name: mm[1],
            ...(titleMatch ? { title: titleMatch[2] } : {}),
            ...(docs.fields[mm[1]] ? { doc: docs.fields[mm[1]] } : {}),
          });
        }
        out.enums.push(sym);
        i = end;
        continue;
      }
      const head = METHOD_HEAD_RE.exec(trimmed) ?? FUNC_HEAD_RE.exec(trimmed);
      if (head && !RESERVED.has(head[2])) {
        const isMethod = trimmed.startsWith('method') || /^export\s+method\b/.test(trimmed);
        const openAbs = lineStarts[i] + lead + head[0].length - 1;
        const closeAbs = matchParen(maskedText, openAbs);
        if (closeAbs > 0) {
          const after = maskedText.slice(closeAbs + 1, closeAbs + 200);
          const arrow = /^\s*=>/.exec(after);
          if (arrow) {
            const params = parseParams(
              maskedText.slice(openAbs + 1, closeAbs),
              text.slice(openAbs + 1, closeAbs),
            );
            const headerEndLine = lineOf(lineStarts, closeAbs + arrow[0].length);
            const bodyText = text
              .slice(
                closeAbs + 1 + arrow[0].length,
                lineStarts[headerEndLine] + lines[headerEndLine].length,
              )
              .split('//')[0]
              .trim();
            const end = bodyText ? headerEndLine : blockEnd(lines, masked, headerEndLine, 0);
            const docs = readDocBlock(lines, i);
            const sym: PineFunctionSymbol = {
              kind: isMethod ? 'method' : 'function',
              name: head[2],
              params,
              line: i,
              endLine: end,
              exported: !!head[1],
              ...(docs.doc ? { doc: docs.doc } : {}),
              ...(Object.keys(docs.params).length ? { paramDocs: docs.params } : {}),
              ...(docs.returns ? { returnsDoc: docs.returns } : {}),
              ...(isMethod && params[0]?.type ? { receiverType: params[0].type } : {}),
              ...(bodyText ? { body: bodyText } : {}),
            };
            (isMethod ? out.methods : out.functions).push(sym);
            for (const p of params) {
              out.variables.push({
                kind: 'variable',
                name: p.name,
                ...(p.type ? { type: p.type } : {}),
                line: i,
                indent: 4,
                scopeEnd: end,
                role: 'param',
                ...(docs.params[p.name] ? { doc: docs.params[p.name] } : {}),
              });
            }
            continue;
          }
        }
      }
    }

    // Loop variables: scoped to the loop body.
    const forIn = FOR_IN_RE.exec(trimmed);
    const forTo = forIn ? null : FOR_RE.exec(trimmed);
    if (forIn || forTo) {
      const end = blockEnd(lines, masked, i, indent);
      const names = forIn ? (forIn[1] ?? forIn[2]).split(',').map((s) => s.trim()) : [forTo![1]];
      for (const name of names) {
        if (!/^[A-Za-z_]\w*$/.test(name)) continue;
        out.variables.push({
          kind: 'variable',
          name,
          ...(forTo ? { type: 'int' } : {}),
          line: i,
          indent: indent + 4,
          scopeEnd: end,
          role: 'loop',
        });
      }
      continue;
    }

    const scopeEnd =
      indent === 0 ? Number.POSITIVE_INFINITY : blockEnd(lines, masked, i, indent - 1);
    const tuple = TUPLE_DECL_RE.exec(trimmed);
    if (tuple) {
      for (const part of tuple[1].split(',')) {
        const name = part.trim();
        if (/^[A-Za-z_]\w*$/.test(name) && name !== '_') {
          out.variables.push({ kind: 'variable', name, line: i, indent, scopeEnd });
        }
      }
      continue;
    }
    const v = VAR_DECL_RE.exec(trimmed);
    if (v && !RESERVED.has(v[5]) && !(v[4] && RESERVED.has(v[4].split(/[<\s[]/)[0]))) {
      const eqAt = lead + v[0].length;
      const rhsOriginal = original.slice(eqAt).split('//')[0];
      const inferred = inferInitType(rhsOriginal);
      const docs = readDocBlock(lines, i);
      out.variables.push({
        kind: 'variable',
        name: v[5],
        ...(v[4]
          ? { type: v[4].replace(/\s+/g, ' ') }
          : inferred.type
            ? { type: inferred.type }
            : {}),
        ...(v[3] ? { qualifier: v[3] } : {}),
        ...(v[2] ? { declKeyword: v[2] as 'var' | 'varip' } : {}),
        ...(v[1] ? { exported: true } : {}),
        line: i,
        indent,
        scopeEnd,
        ...(inferred.callee ? { initCallee: inferred.callee } : {}),
        ...(rhsOriginal.trim() ? { initText: rhsOriginal.trim() } : {}),
        ...(docs.doc ? { doc: docs.doc } : {}),
      });
    }
  }
  return out;
}

function lineOf(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Variables visible on 0-based `line` (globals declared above it, locals whose scope covers it). */
export function variablesInScope(symbols: PineDocSymbols, line: number): PineVariableSymbol[] {
  const seen = new Map<string, PineVariableSymbol>();
  for (const v of symbols.variables) {
    const visible =
      v.role === 'param' || v.role === 'loop'
        ? line >= v.line && line <= v.scopeEnd
        : v.line <= line && line <= v.scopeEnd;
    if (!visible) continue;
    const prev = seen.get(v.name);
    // The innermost (latest-declared) binding wins.
    if (!prev || prev.line <= v.line) seen.set(v.name, v);
  }
  return [...seen.values()];
}

// ── Cursor context ─────────────────────────────────────────────────────────

export interface PineCallContext {
  /** Dotted callee with any generic argument stripped: `ta.ema`, `arr.push`, `Point.new`. */
  callee: string;
  /** Offset of the call's `(`. */
  openParen: number;
  /** 0-based index of the argument the cursor is in. */
  argIndex: number;
  /** Set when the current argument is written `name = …`. */
  namedArg: string | null;
  /** Names already passed as `name = …` in this call. */
  usedNamedArgs: string[];
  /** Offset where the current argument starts. */
  argStart: number;
}

/**
 * The innermost call whose argument list contains `offset`, read from MASKED text. Grouping
 * parentheses and `if (…)`-style keyword parentheses are looked through.
 */
export function findCallContext(
  masked: string,
  offset: number,
  maxScan = 6000,
): PineCallContext | null {
  let depth = 0;
  let firstComma = -1;
  const floor = Math.max(0, offset - maxScan);
  for (let i = offset - 1; i >= floor; i--) {
    const c = masked[i];
    if (c === ')' || c === ']') {
      depth++;
    } else if (c === '[') {
      if (depth === 0) {
        // Inside a subscript or tuple — it may itself sit inside a call's argument.
        firstComma = -1;
        continue;
      }
      depth--;
    } else if (c === '(') {
      if (depth > 0) {
        depth--;
        continue;
      }
      const head = /([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_][\w]*)*)\s*(?:<[^()]*>)?\s*$/.exec(
        masked.slice(Math.max(0, i - 240), i),
      );
      const callee = head?.[1].replace(/\s+/g, '');
      if (!callee || NON_CALL_WORDS.has(callee)) {
        // A grouping parenthesis: keep looking for the call outside it.
        firstComma = -1;
        continue;
      }
      const argStart = firstComma >= 0 ? firstComma + 1 : i + 1;
      const args = splitTopLevel(masked.slice(i + 1, offset));
      const usedNamedArgs: string[] = [];
      for (let k = 0; k < args.length - 1; k++) {
        const nm = /^\s*([A-Za-z_]\w*)\s*=(?![=>])/.exec(args[k].text);
        if (nm) usedNamedArgs.push(nm[1]);
      }
      const current = /^\s*([A-Za-z_]\w*)\s*=(?![=>])/.exec(masked.slice(argStart, offset));
      return {
        callee,
        openParen: i,
        argIndex: args.length - 1,
        namedArg: current ? current[1] : null,
        usedNamedArgs,
        argStart,
      };
    } else if (c === ',' && depth === 0 && firstComma < 0) {
      firstComma = i;
    }
  }
  return null;
}

/** The dotted identifier path ending at the word under `offset` (e.g. `ta.ema` when on `ema`). */
export function identifierPathAt(
  text: string,
  offset: number,
): { path: string; from: number; to: number; wordFrom: number } | null {
  const isWord = (ch: string | undefined) => !!ch && /[A-Za-z0-9_]/.test(ch);
  let from = offset;
  let to = offset;
  while (from > 0 && isWord(text[from - 1])) from--;
  while (to < text.length && isWord(text[to])) to++;
  if (from === to || /[0-9]/.test(text[from])) return null;
  const wordFrom = from;
  while (from > 1 && text[from - 1] === '.' && isWord(text[from - 2])) {
    let s = from - 1;
    while (s > 0 && isWord(text[s - 1])) s--;
    if (/[0-9]/.test(text[s])) break;
    from = s;
  }
  return { path: text.slice(from, to), from, to, wordFrom };
}

/** The declaration statement kind and title from the source, without compiling. */
export function readDeclarationHeader(
  text: string,
): { kind: 'indicator' | 'strategy' | 'library'; title: string | null } | null {
  const masked = maskCommentsAndStrings(text);
  const m = /(^|\n)(indicator|strategy|library)\s*\(/.exec(masked);
  if (!m) return null;
  const start = m.index + m[0].length;
  const title = /^\s*(?:title\s*=\s*)?(["'])(.*?)\1/.exec(text.slice(start, start + 400));
  return { kind: m[2] as 'indicator' | 'strategy' | 'library', title: title ? title[2] : null };
}

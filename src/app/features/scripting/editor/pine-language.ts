import {
  foldService,
  indentService,
  LanguageSupport,
  StreamLanguage,
  type StreamParser,
  type StringStream,
} from '@codemirror/language';
import { tags as t, type Tag } from '@lezer/highlight';

import {
  PINE_CONTROL_KEYWORDS,
  PINE_DEFINITION_KEYWORDS,
  PINE_OPERATOR_KEYWORDS,
  PINE_QUALIFIERS,
  PINE_TYPE_SET,
} from '../pine/pine-lexicon';
import { computePineIndent, pineFoldEnd } from '../pine/pine-indent';

/** The built-in names the tokenizer highlights (from the catalog, or the offline fallback). */
export interface PineTokenizerNames {
  functions: ReadonlySet<string>;
  variables: ReadonlySet<string>;
  constants: ReadonlySet<string>;
  namespaces: ReadonlySet<string>;
}

export interface PineStreamState {
  /** Inside a `"""` / `'''` string spanning lines. */
  multiline: '"""' | "'''" | null;
  /** The rest of the current line is a comment (after an annotation or region marker). */
  lineComment: 'doc' | 'region' | null;
  /** The previous token was a `.` — the next identifier is a member. */
  afterDot: boolean;
  /** The next identifier names a declaration: a type/enum (`type Foo`) or an import alias. */
  pendingDef: 'type' | 'alias' | 'method' | null;
  /** An `@param` / `@field` annotation's name is next. */
  pendingDocName: boolean;
  /** Open parentheses — `name = value` inside them is a named argument, not a declaration. */
  parenDepth: number;
}

/** Token names → highlight tags. Names are also the syntax-tree node names. */
export const PINE_TOKEN_TABLE: Record<string, Tag | readonly Tag[]> = {
  pineKeyword: t.keyword,
  pineControl: t.controlKeyword,
  pineDefinitionKeyword: t.definitionKeyword,
  pineOperatorKeyword: t.operatorKeyword,
  pineModifier: t.modifier,
  pineType: t.typeName,
  pineTypeDefinition: t.definition(t.typeName),
  pineNamespace: t.namespace,
  pineBuiltinFunction: t.function(t.standard(t.variableName)),
  pineBuiltinVariable: t.standard(t.variableName),
  pineBuiltinConstant: t.constant(t.standard(t.variableName)),
  pineFunctionDefinition: t.function(t.definition(t.variableName)),
  pineFunctionCall: t.function(t.variableName),
  pineMethodCall: t.function(t.propertyName),
  pineProperty: t.propertyName,
  pineVariable: t.variableName,
  pineString: t.string,
  pineNumber: t.number,
  pineColor: t.color,
  pineBool: t.bool,
  pineNa: t.null,
  pineComment: t.lineComment,
  pineDocComment: t.docComment,
  pineAnnotation: t.annotation,
  pineRegion: t.special(t.lineComment),
  pineOperator: t.operator,
  pineArrow: t.definitionOperator,
  pinePunctuation: t.punctuation,
  pineSeparator: t.separator,
  pineParen: t.paren,
  pineBracket: t.squareBracket,
};

const IDENT_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
/** `name(params) =>` on one line — a function definition header. */
const FUNC_DEF_AHEAD_RE = /^\s*\((?:[^()]|\([^()]*\))*\)\s*=>/;

/** Builds the Pine v6 stream tokenizer over a set of built-in names. */
export function createPineStreamParser(names: PineTokenizerNames): StreamParser<PineStreamState> {
  /**
   * A built-in's token kind. Some names are both a variable and a function (`time`,
   * `dayofweek`): followed by a call (or a generic `<T>`) they read as the function.
   */
  const builtinKind = (path: string, call: boolean): string | null => {
    const fn = names.functions.has(path);
    const variable = names.variables.has(path);
    const constant = names.constants.has(path);
    if (fn && (call || (!variable && !constant))) return 'pineBuiltinFunction';
    if (variable) return 'pineBuiltinVariable';
    if (constant) return 'pineBuiltinConstant';
    return fn ? 'pineBuiltinFunction' : null;
  };

  const readString = (stream: StringStream, quote: string): void => {
    let escaped = false;
    while (!stream.eol()) {
      const c = stream.next();
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) return;
    }
  };

  const identifier = (stream: StringStream, state: PineStreamState): string => {
    const afterDot = state.afterDot;
    state.afterDot = false;
    const pathMatch = stream.match(IDENT_PATH_RE, false) as RegExpMatchArray;
    const path = pathMatch[0];
    const segments = path.split('.');
    const first = segments[0];
    const after = (len: number) => stream.string.slice(stream.pos + len);
    /** A call follows the name (`f(`), or a generic argument list and then a call (`f<T>(`). */
    const callAhead = (len: number) => /^\s*\(|^<[^()]*>\s*\(/.test(after(len));

    if (afterDot) {
      stream.match(IDENT_RE);
      return /^\s*\(/.test(stream.string.slice(stream.pos)) ? 'pineMethodCall' : 'pineProperty';
    }

    if (state.pendingDef) {
      const def = state.pendingDef;
      state.pendingDef = null;
      stream.match(IDENT_RE);
      if (def === 'type') return 'pineTypeDefinition';
      if (def === 'alias') return 'pineNamespace';
      return 'pineFunctionDefinition';
    }

    if (segments.length === 1) {
      if (PINE_OPERATOR_KEYWORDS.has(first)) {
        stream.match(IDENT_RE);
        return 'pineOperatorKeyword';
      }
      if (first === 'true' || first === 'false') {
        stream.match(IDENT_RE);
        return 'pineBool';
      }
      if (first === 'na' && !callAhead(2)) {
        stream.match(IDENT_RE);
        return 'pineNa';
      }
      if (PINE_CONTROL_KEYWORDS.has(first)) {
        stream.match(IDENT_RE);
        return 'pineControl';
      }
      if (PINE_DEFINITION_KEYWORDS.has(first)) {
        stream.match(IDENT_RE);
        if (first === 'type' || first === 'enum') state.pendingDef = 'type';
        else if (first === 'as') state.pendingDef = 'alias';
        else if (first === 'method') state.pendingDef = 'method';
        return 'pineDefinitionKeyword';
      }
      if (PINE_QUALIFIERS.has(first)) {
        stream.match(IDENT_RE);
        return 'pineModifier';
      }
      // `plot(x, color = color.red)` — a named argument.
      if (state.parenDepth > 0 && /^\s*=(?![=>])/.test(after(first.length))) {
        stream.match(IDENT_RE);
        return 'pineProperty';
      }
    }

    // `chart.point` is a type keyword spelled like a namespace member.
    if (path === 'chart.point' && !callAhead(path.length)) {
      stream.match('chart.point');
      return 'pineType';
    }

    // Longest dotted prefix that names a built-in: `ta.ema`, `strategy.risk.allow_entry_in`.
    for (let k = segments.length; k >= 1; k--) {
      const prefix = segments.slice(0, k).join('.');
      // A type keyword used as a type (`float x`, `array<float>`), not as a namespace
      // (`color.red`) or a cast (`float(x)`).
      if (
        k === 1 &&
        PINE_TYPE_SET.has(prefix) &&
        !/^\s*\(/.test(after(prefix.length)) &&
        after(prefix.length).charAt(0) !== '.'
      ) {
        stream.match(prefix);
        return 'pineType';
      }
      const kind = builtinKind(prefix, callAhead(prefix.length));
      if (kind) {
        stream.match(prefix);
        return kind;
      }
    }

    if (segments.length > 1 && names.namespaces.has(first)) {
      stream.match(first);
      return 'pineNamespace';
    }

    stream.match(IDENT_RE);
    const rest = stream.string.slice(stream.pos);
    if (!/^\s*\(/.test(rest)) return 'pineVariable';
    // `name(params) =>` at the start of a line defines a function; anywhere else it is a call.
    const atLineStart = /^(?:export\s+)?$/.test(stream.string.slice(0, stream.start));
    return atLineStart && FUNC_DEF_AHEAD_RE.test(rest)
      ? 'pineFunctionDefinition'
      : 'pineFunctionCall';
  };

  return {
    name: 'pine',
    startState: () => ({
      multiline: null,
      lineComment: null,
      afterDot: false,
      pendingDef: null,
      pendingDocName: false,
      parenDepth: 0,
    }),
    copyState: (s) => ({ ...s }),
    token(stream, state) {
      if (stream.sol()) {
        state.lineComment = null;
        state.pendingDocName = false;
        state.afterDot = false;
        state.pendingDef = null;
        // A statement starting in column 0 is never inside an earlier call's parentheses.
        if (!state.multiline && /^\S/.test(stream.string)) state.parenDepth = 0;
      }

      if (state.multiline) {
        const delim = state.multiline;
        while (!stream.eol()) {
          if (stream.match(delim)) {
            state.multiline = null;
            return 'pineString';
          }
          stream.next();
        }
        return 'pineString';
      }

      if (state.lineComment) {
        if (state.pendingDocName && stream.eatSpace())
          return state.lineComment === 'doc' ? 'pineDocComment' : 'pineComment';
        if (state.pendingDocName && stream.match(IDENT_RE)) {
          state.pendingDocName = false;
          return 'pineVariable';
        }
        state.pendingDocName = false;
        stream.skipToEnd();
        return state.lineComment === 'doc' ? 'pineDocComment' : 'pineComment';
      }

      if (stream.eatSpace()) return null;

      if (stream.match('//')) {
        const annotation = stream.match(/^\s*@[A-Za-z_]+=?/) as RegExpMatchArray | null;
        if (annotation) {
          state.lineComment = 'doc';
          state.pendingDocName = /@(param|field)$/.test(annotation[0]);
          return 'pineAnnotation';
        }
        if (stream.match(/^\s*#(?:end)?region\b/)) {
          state.lineComment = 'region';
          return 'pineRegion';
        }
        stream.skipToEnd();
        return 'pineComment';
      }

      const ch = stream.peek() as string;

      if ((ch === '"' || ch === "'") && stream.match(ch + ch + ch)) {
        const delim = (ch + ch + ch) as '"""' | "'''";
        while (!stream.eol()) {
          if (stream.match(delim)) return 'pineString';
          stream.next();
        }
        state.multiline = delim;
        return 'pineString';
      }
      if (ch === '"' || ch === "'") {
        stream.next();
        readString(stream, ch);
        state.afterDot = false;
        return 'pineString';
      }

      if (ch === '#') {
        if (stream.match(/^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z_])/)) return 'pineColor';
        stream.next();
        return null;
      }

      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(stream.string.charAt(stream.pos + 1)))) {
        stream.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
        state.afterDot = false;
        return 'pineNumber';
      }

      if (/[A-Za-z_]/.test(ch)) return identifier(stream, state);

      state.afterDot = false;
      if (stream.match('=>')) return 'pineArrow';
      if (stream.match(/^(?::=|==|!=|>=|<=|\+=|-=|\*=|\/=|%=)/)) return 'pineOperator';
      if (/[+\-*/%<>=?:]/.test(ch)) {
        stream.next();
        return 'pineOperator';
      }
      if (ch === '(' || ch === ')') {
        stream.next();
        state.parenDepth = ch === '(' ? state.parenDepth + 1 : Math.max(0, state.parenDepth - 1);
        return 'pineParen';
      }
      if (ch === '[' || ch === ']') {
        stream.next();
        return 'pineBracket';
      }
      if (ch === ',') {
        stream.next();
        return 'pineSeparator';
      }
      if (ch === '.') {
        stream.next();
        state.afterDot = true;
        return 'pinePunctuation';
      }
      stream.next();
      return null;
    },
    blankLine(state) {
      state.lineComment = null;
      state.pendingDocName = false;
    },
    languageData: {
      commentTokens: { line: '//' },
      indentOnInput: /^\s*(?:else|[)\]])$/,
      closeBrackets: { brackets: ['(', '[', '"', "'"] },
      wordChars: '_',
    },
    tokenTable: PINE_TOKEN_TABLE,
  };
}

export function pineStreamLanguage(names: PineTokenizerNames): StreamLanguage<PineStreamState> {
  return StreamLanguage.define(createPineStreamParser(names));
}

/**
 * The Pine v6 language support: the tokenizer plus indentation (four-space blocks, never a
 * multiple of four for wrapped lines outside brackets) and folding (blocks and `//#region`).
 */
export function pineLanguageSupport(names: PineTokenizerNames): LanguageSupport {
  const language = pineStreamLanguage(names);
  return new LanguageSupport(language, [
    indentService.of((context, pos) => {
      const doc = context.state.doc;
      const line = doc.lineAt(pos);
      const index = line.number - 1;
      if (context.simulatedBreak === pos) {
        // Enter: the line being indented does not exist yet. It holds the text after the
        // break, and the current line ends at the break.
        const before = line.text.slice(0, pos - line.from);
        const after = line.text.slice(pos - line.from);
        const read = (i: number): string =>
          i < index ? doc.line(i + 1).text : i === index ? before : i === index + 1 ? after : '';
        return computePineIndent(read, index + 1);
      }
      return computePineIndent((i) => doc.line(i + 1).text, index);
    }),
    foldService.of((state, lineStart) => {
      const doc = state.doc;
      const line = doc.lineAt(lineStart);
      const end = pineFoldEnd((i) => doc.line(i + 1).text, doc.lines, line.number - 1);
      if (end === null) return null;
      return { from: line.to, to: doc.line(end + 1).to };
    }),
  ]);
}

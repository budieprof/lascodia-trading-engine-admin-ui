import {
  insertCompletionText,
  snippet,
  snippetCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';

import type { PineCatalogFunction } from '@core/api/scripting.types';
import { stripGeneric, type PineCatalogIndex, type PineMember } from '../pine/pine-catalog-index';
import { docViewFor } from '../pine/pine-docs';
import { PINE_ANNOTATIONS, PINE_KEYWORDS, PINE_TYPES } from '../pine/pine-lexicon';
import {
  libraryFor,
  methodNamespace,
  resolvePinePath,
  variableType,
  type PineResolveEnv,
} from '../pine/pine-resolve';
import {
  EMPTY_SYMBOLS,
  findCallContext,
  variablesInScope,
  type PineDocSymbols,
} from '../pine/pine-scan';
import { overloadsFor } from '../pine/pine-signature';
import { PINE_SNIPPETS } from '../pine/pine-snippets';
import { docSymbols, inCommentOrString, maskedDoc, pineContext } from './pine-context';
import { renderDocView } from './pine-dom';

const WORD = /^[A-Za-z0-9_]*$/;

/** `ta.ema(source, length) → series float` shortened for the completion row. */
function fnDetail(fn: PineCatalogFunction): string | undefined {
  const o = fn.overloads[0];
  if (!o) return undefined;
  const more = fn.overloads.length > 1 ? ` +${fn.overloads.length - 1}` : '';
  return `(${o.params.map((p) => p.name).join(', ')})${o.returns ? ` → ${o.returns}` : ''}${more}`;
}

/** Inserts `name()` with the cursor between the parentheses (or just `name` before an existing `(`). */
function callApply(name: string, hasParams: boolean) {
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    if (view.state.sliceDoc(to, to + 1) === '(') {
      view.dispatch(insertCompletionText(view.state, name, from, to));
      return;
    }
    snippet(hasParams ? `${name}(\${})` : `${name}()\${}`)(view, completion, from, to);
  };
}

/** Inserts `ns.` and reopens completion on the namespace's members. */
function namespaceApply(name: string) {
  return (view: EditorView, _c: Completion, from: number, to: number): void => {
    view.dispatch(insertCompletionText(view.state, `${name}.`, from, to));
    setTimeout(() => startCompletion(view), 0);
  };
}

function infoFor(path: string, env: PineResolveEnv, preferCall: boolean): Completion['info'] {
  return () => {
    const resolved = resolvePinePath(path, env, preferCall);
    return resolved ? renderDocView(docViewFor(resolved, path), 'cm-pine-hover') : null;
  };
}

/** Docs of a built-in, independent of the document (these completions are cached). */
function builtinEnv(index: PineCatalogIndex): PineResolveEnv {
  return { index, symbols: EMPTY_SYMBOLS, libraries: [], line: 0 };
}

function builtinMemberCompletion(m: PineMember, index: PineCatalogIndex): Completion {
  const env = builtinEnv(index);
  switch (m.kind) {
    case 'function': {
      const fn = index.functions.get(m.path)!;
      const hasParams = fn.overloads.length === 0 || fn.overloads.some((o) => o.params.length > 0);
      return {
        label: m.name,
        type: 'function',
        detail: fnDetail(fn),
        info: infoFor(m.path, env, true),
        apply: callApply(m.name, hasParams),
        ...(fn.deprecated ? { boost: -20 } : {}),
      };
    }
    case 'variable': {
      const v = index.variables.get(m.path);
      return {
        label: m.name,
        type: 'variable',
        detail: v?.type || undefined,
        info: infoFor(m.path, env, false),
      };
    }
    case 'constant': {
      const c = index.constants.get(m.path);
      return {
        label: m.name,
        type: 'constant',
        detail: c?.valueText ?? (c?.type || undefined),
        info: infoFor(m.path, env, false),
      };
    }
    default:
      return {
        label: m.name,
        type: 'namespace',
        detail: 'namespace',
        apply: namespaceApply(m.name),
      };
  }
}

/** Completions after `receiver.` — namespace members, library exports, fields and methods. */
export function memberCompletions(receiver: string, env: PineResolveEnv): Completion[] {
  const { index, symbols, libraries } = env;
  const out: Completion[] = [];
  const clean = stripGeneric(receiver);

  if (index.isNamespace(clean)) {
    for (const m of index.membersOf(clean)) out.push(builtinMemberCompletion(m, index));
  }

  const imp = symbols.imports.find((i) => i.alias === clean);
  if (imp) {
    const lib = libraryFor(imp, libraries);
    for (const e of lib?.exports ?? []) {
      const isFn = e.kind === 'function' || e.kind === 'method';
      out.push({
        label: e.name,
        type: isFn
          ? 'function'
          : e.kind === 'type'
            ? 'class'
            : e.kind === 'enum'
              ? 'enum'
              : 'constant',
        detail: e.signature ?? e.kind,
        info: e.doc ?? undefined,
        ...(isFn ? { apply: callApply(e.name, true) } : {}),
      });
    }
    return out;
  }

  const udt = symbols.types.find((t) => t.name === clean);
  if (udt) {
    out.push({
      label: 'new',
      type: 'function',
      detail: `(${udt.fields.map((f) => f.name).join(', ')}) → ${udt.name}`,
      apply: callApply('new', udt.fields.length > 0),
      boost: 10,
    });
    out.push({
      label: 'copy',
      type: 'function',
      detail: `(object) → ${udt.name}`,
      apply: callApply('copy', true),
    });
  }
  const en = symbols.enums.find((e) => e.name === clean);
  if (en) {
    for (const m of en.members) {
      out.push({
        label: m.name,
        type: 'enum',
        detail: m.title ? `"${m.title}"` : en.name,
        info: m.doc,
      });
    }
  }
  if (out.length) return out;

  // A value: find its type through the receiver chain (`a.b.c`).
  const segments = clean.split('.');
  const receiverVar = variablesInScope(symbols, env.line).find((v) => v.name === segments[0]);
  let type = receiverVar ? variableType(receiverVar, index) : null;
  for (let i = 1; i < segments.length && type; i++) {
    const t = symbols.types.find((x) => x.name === stripGeneric(type!));
    type = t?.fields.find((f) => f.name === segments[i])?.type ?? null;
  }
  if (!type) {
    // Unknown receiver type: the user's methods still apply.
    return symbols.methods.map((m) =>
      userFunctionCompletion(
        m.name,
        m.params.slice(1).map((p) => p.name),
        'method',
        m.doc,
      ),
    );
  }

  const typeName = stripGeneric(type);
  const userType = symbols.types.find((t) => t.name === typeName);
  if (userType) {
    for (const f of userType.fields) {
      out.push({ label: f.name, type: 'property', detail: f.type, info: f.doc, boost: 5 });
    }
    out.push({
      label: 'copy',
      type: 'method',
      detail: `() → ${userType.name}`,
      apply: callApply('copy', false),
    });
  }
  for (const m of symbols.methods) {
    if (m.receiverType && stripGeneric(m.receiverType) !== typeName) continue;
    out.push(
      userFunctionCompletion(
        m.name,
        m.params.slice(1).map((p) => p.name),
        'method',
        m.doc,
      ),
    );
  }
  if (methodNamespace(type)) {
    for (const fn of index.methodsForType(type)) {
      const name = fn.name.slice(fn.name.lastIndexOf('.') + 1);
      const o = fn.overloads.find((x) => x.method) ?? fn.overloads[0];
      out.push({
        label: name,
        type: 'method',
        detail: o
          ? `(${o.params
              .slice(1)
              .map((p) => p.name)
              .join(', ')})${o.returns ? ` → ${o.returns}` : ''}`
          : undefined,
        info: infoFor(`${receiver}.${name}`, env, true),
        apply: callApply(name, !o || o.params.length > 1),
      });
    }
  }
  return out;
}

function userFunctionCompletion(
  name: string,
  params: string[],
  type: 'function' | 'method',
  doc?: string,
): Completion {
  return {
    label: name,
    type,
    detail: `(${params.join(', ')})`,
    info: doc,
    apply: callApply(name, params.length > 0),
    boost: 4,
  };
}

/** The operator's own names visible on a line. */
function userCompletions(symbols: PineDocSymbols, env: PineResolveEnv): Completion[] {
  const out: Completion[] = [];
  for (const v of variablesInScope(symbols, env.line)) {
    out.push({
      label: v.name,
      type: 'variable',
      detail: variableType(v, env.index) ?? undefined,
      info: infoFor(v.name, env, false),
      boost: 6,
    });
  }
  for (const f of [...symbols.functions, ...symbols.methods]) {
    out.push(
      userFunctionCompletion(
        f.name,
        f.params.map((p) => p.name),
        'function',
        f.doc,
      ),
    );
  }
  for (const t of symbols.types)
    out.push({ label: t.name, type: 'class', detail: 'type', info: t.doc, boost: 3 });
  for (const e of symbols.enums)
    out.push({ label: e.name, type: 'enum', detail: 'enum', info: e.doc, boost: 3 });
  for (const i of symbols.imports) {
    out.push({
      label: i.alias,
      type: 'namespace',
      detail: `${i.publisher}/${i.libraryName}/${i.version}`,
      apply: namespaceApply(i.alias),
      boost: 3,
    });
  }
  return out;
}

/** `name = ` completions for the parameters of the call around the cursor. */
function namedArgCompletions(context: CompletionContext, env: PineResolveEnv): Completion[] {
  const call = findCallContext(maskedDoc(context.state), context.pos);
  if (!call || call.namedArg) return [];
  const current = context.state.sliceDoc(call.argStart, context.pos);
  if (!/^\s*[A-Za-z_]?\w*$/.test(current)) return [];
  const resolved = resolvePinePath(call.callee, env, true);
  if (!resolved) return [];
  const { overloads } = overloadsFor(resolved, call.callee);
  const seen = new Set<string>(call.usedNamedArgs);
  const out: Completion[] = [];
  for (const o of overloads) {
    for (const p of o.params) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      out.push({
        label: `${p.name} =`,
        apply: `${p.name} = `,
        type: 'property',
        detail: p.type,
        info: p.doc,
        boost: 8,
      });
    }
  }
  return out;
}

let staticCache: { index: PineCatalogIndex; options: Completion[] } | null = null;

/** Keywords, type keywords, namespaces and top-level built-ins — rebuilt when the catalog changes. */
function staticCompletions(index: PineCatalogIndex): Completion[] {
  if (staticCache?.index === index) return staticCache.options;
  const options: Completion[] = [];
  const keywords = new Set([...index.keywords, ...PINE_KEYWORDS]);
  for (const k of keywords) options.push({ label: k, type: 'keyword', boost: -2 });
  for (const t of PINE_TYPES) {
    if (t.includes('.')) continue;
    options.push({ label: t, type: 'type', detail: 'type', boost: -1 });
  }
  for (const m of index.membersOf('')) options.push(builtinMemberCompletion(m, index));
  staticCache = { index, options };
  return options;
}

function snippetCompletions(atLineStart: boolean): Completion[] {
  return PINE_SNIPPETS.filter((s) => atLineStart || !s.lineStart).map((s) =>
    snippetCompletion(s.template, {
      label: s.label,
      detail: s.detail,
      type: 'text',
      section: { name: 'Snippets', rank: 2 },
      boost: -5,
    }),
  );
}

/**
 * Pine completion: namespace-aware members after `.`, the operator's own declarations in scope,
 * keywords, types, built-ins, named arguments inside calls, `import` paths and snippets.
 */
export function pineCompletionSource(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);

  if (inCommentOrString(state, pos)) {
    const annotation = /\/\/\s*(@[A-Za-z_]*=?)$/.exec(before);
    if (!annotation) return null;
    return {
      from: pos - annotation[1].length,
      options: PINE_ANNOTATIONS.map((a) => ({ label: a, type: 'keyword' })),
      validFor: /^@[A-Za-z_]*=?$/,
    };
  }

  const { index, libraries } = pineContext(state);
  const symbols = docSymbols(state);
  const env: PineResolveEnv = { index, symbols, libraries, line: line.number - 1 };

  const importPath = /^import\s+([A-Za-z0-9_\-/]*)$/.exec(before);
  if (importPath) {
    return {
      from: pos - importPath[1].length,
      options: libraries.map((l) => {
        const path = `${l.publisher}/${l.name}/${l.version}`;
        const alias = l.name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
        return {
          label: path,
          type: 'namespace',
          detail: l.description ?? undefined,
          apply: `${path} as ${alias}`,
        };
      }),
      validFor: /^[A-Za-z0-9_\-/]*$/,
    };
  }

  const member =
    /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)?$/.exec(
      before,
    );
  if (member) {
    const partial = member[2] ?? '';
    const options = memberCompletions(member[1], env);
    return options.length ? { from: pos - partial.length, options, validFor: WORD } : null;
  }

  const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*$/);
  if (word && word.from > line.from && /[0-9.#]/.test(state.sliceDoc(word.from - 1, word.from))) {
    return null;
  }
  if (!word && !context.explicit) return null;
  const from = word ? word.from : pos;
  const atLineStart = /^\s*$/.test(line.text.slice(0, from - line.from));

  const options = [
    ...namedArgCompletions(context, env),
    ...userCompletions(symbols, env),
    ...staticCompletions(index),
    ...snippetCompletions(atLineStart),
  ];
  return { from, options, validFor: WORD };
}

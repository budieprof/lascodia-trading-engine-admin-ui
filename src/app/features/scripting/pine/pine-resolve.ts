import type {
  PineCatalogConstant,
  PineCatalogFunction,
  PineCatalogVariable,
  ScriptExportDto,
  ScriptLibraryDto,
} from '@core/api/scripting.types';
import { baseType, stripGeneric, type PineCatalogIndex } from './pine-catalog-index';
import { PINE_KEYWORDS, PINE_KEYWORD_DOCS, PINE_TYPE_SET } from './pine-lexicon';
import {
  variablesInScope,
  type PineDocSymbols,
  type PineEnumMember,
  type PineEnumSymbol,
  type PineFunctionSymbol,
  type PineImportSymbol,
  type PineTypeField,
  type PineTypeSymbol,
  type PineVariableSymbol,
} from './pine-scan';

/** What a name in the source refers to. */
export type PineResolved =
  | { kind: 'builtin-function'; path: string; fn: PineCatalogFunction }
  | { kind: 'builtin-variable'; path: string; variable: PineCatalogVariable }
  | { kind: 'builtin-constant'; path: string; constant: PineCatalogConstant }
  | {
      kind: 'builtin-method';
      name: string;
      fns: readonly PineCatalogFunction[];
      receiverType?: string;
    }
  | { kind: 'namespace'; path: string }
  | { kind: 'keyword'; name: string; doc: string | null }
  | { kind: 'type-keyword'; name: string; doc: string | null }
  | { kind: 'user-function'; fn: PineFunctionSymbol }
  | { kind: 'user-method'; name: string; methods: PineFunctionSymbol[]; receiverType?: string }
  | { kind: 'user-variable'; variable: PineVariableSymbol; type: string | null }
  | { kind: 'user-type'; type: PineTypeSymbol; ctor?: 'new' | 'copy' }
  | { kind: 'user-type-field'; type: PineTypeSymbol; field: PineTypeField }
  | { kind: 'user-enum'; enumSymbol: PineEnumSymbol }
  | { kind: 'user-enum-member'; enumSymbol: PineEnumSymbol; member: PineEnumMember }
  | { kind: 'import'; imp: PineImportSymbol; library: ScriptLibraryDto | null }
  | {
      kind: 'library-export';
      imp: PineImportSymbol;
      library: ScriptLibraryDto | null;
      exported: ScriptExportDto;
    };

export interface PineResolveEnv {
  index: PineCatalogIndex;
  symbols: PineDocSymbols;
  libraries: readonly ScriptLibraryDto[];
  /** 0-based line the name appears on (locals are scoped). */
  line: number;
}

const KEYWORD_SET = new Set(PINE_KEYWORDS);

/** Receiver type → the namespace holding its built-in methods. */
export function methodNamespace(type: string): string | null {
  const t = stripGeneric(type.trim()).replace(/\[\]$/, '');
  if (t === 'string') return 'str';
  if (
    [
      'array',
      'matrix',
      'map',
      'line',
      'label',
      'box',
      'table',
      'polyline',
      'linefill',
      'chart.point',
      'footprint',
      'volume_row',
    ].includes(t)
  )
    return t;
  if (type.trim().endsWith('[]')) return 'array';
  return null;
}

/** The library an import names, from the loaded library list. */
export function libraryFor(
  imp: PineImportSymbol,
  libraries: readonly ScriptLibraryDto[],
): ScriptLibraryDto | null {
  return (
    libraries.find(
      (l) =>
        l.publisher.toLowerCase() === imp.publisher.toLowerCase() &&
        l.name.toLowerCase() === imp.libraryName.toLowerCase() &&
        l.version === imp.version,
    ) ??
    libraries.find(
      (l) =>
        l.publisher.toLowerCase() === imp.publisher.toLowerCase() &&
        l.name.toLowerCase() === imp.libraryName.toLowerCase(),
    ) ??
    null
  );
}

/** A variable's type: declared, inferred from a literal/constructor, or the catalog's return type. */
export function variableType(v: PineVariableSymbol, index: PineCatalogIndex): string | null {
  if (v.type) return v.type;
  if (v.initCallee) return baseType(index.returnTypeOf(v.initCallee));
  return null;
}

function findUserType(symbols: PineDocSymbols, name: string): PineTypeSymbol | undefined {
  return symbols.types.find((t) => t.name === name);
}

/** Resolves a dotted path (`ta.ema`, `myArr.push`, `Point.new`, `lib.fn`) at a line. */
export function resolvePinePath(
  path: string,
  env: PineResolveEnv,
  preferCall = false,
): PineResolved | null {
  const clean = stripGeneric(path);
  const segments = clean.split('.');
  const { index, symbols, libraries, line } = env;

  if (segments.length === 1) {
    const name = segments[0];
    if (KEYWORD_SET.has(name))
      return { kind: 'keyword', name, doc: PINE_KEYWORD_DOCS[name] ?? null };
    const userFn = symbols.functions.find((f) => f.name === name);
    if (userFn && (preferCall || !variablesInScope(symbols, line).some((v) => v.name === name))) {
      return { kind: 'user-function', fn: userFn };
    }
    const local = variablesInScope(symbols, line).find((v) => v.name === name);
    if (local) return { kind: 'user-variable', variable: local, type: variableType(local, index) };
    const userType = findUserType(symbols, name);
    if (userType) return { kind: 'user-type', type: userType };
    const userEnum = symbols.enums.find((e) => e.name === name);
    if (userEnum) return { kind: 'user-enum', enumSymbol: userEnum };
    const imp = symbols.imports.find((i) => i.alias === name);
    if (imp) return { kind: 'import', imp, library: libraryFor(imp, libraries) };
    if (PINE_TYPE_SET.has(name) && !(preferCall && index.functions.has(name))) {
      return {
        kind: 'type-keyword',
        name,
        doc: index.types.get(name)?.doc ?? PINE_KEYWORD_DOCS[name] ?? null,
      };
    }
  }

  // Built-ins by their full path.
  const builtin = index.lookup(clean, preferCall);
  if (builtin && builtin.kind !== 'namespace') {
    if (builtin.kind === 'function')
      return { kind: 'builtin-function', path: clean, fn: builtin.fn };
    if (builtin.kind === 'variable')
      return { kind: 'builtin-variable', path: clean, variable: builtin.variable };
    return { kind: 'builtin-constant', path: clean, constant: builtin.constant };
  }
  if (clean === 'chart.point') {
    return {
      kind: 'type-keyword',
      name: clean,
      doc: index.types.get(clean)?.doc ?? PINE_KEYWORD_DOCS[clean] ?? null,
    };
  }
  if (builtin?.kind === 'namespace') return { kind: 'namespace', path: clean };
  if (segments.length < 2) return null;

  const head = segments[0];
  const member = segments[segments.length - 1];

  const imp = symbols.imports.find((i) => i.alias === head);
  if (imp && segments.length === 2) {
    const library = libraryFor(imp, libraries);
    const exported = library?.exports?.find((e) => e.name === member);
    if (exported) return { kind: 'library-export', imp, library, exported };
    return { kind: 'import', imp, library };
  }

  const userType = findUserType(symbols, head);
  if (userType && segments.length === 2) {
    if (member === 'new' || member === 'copy') {
      return { kind: 'user-type', type: userType, ctor: member };
    }
  }
  const userEnum = symbols.enums.find((e) => e.name === head);
  if (userEnum && segments.length === 2) {
    const m = userEnum.members.find((x) => x.name === member);
    if (m) return { kind: 'user-enum-member', enumSymbol: userEnum, member: m };
  }

  // `receiver.member` — resolve the receiver's type through the chain.
  let type: string | null = null;
  const receiver = variablesInScope(symbols, line).find((v) => v.name === head);
  if (receiver) type = variableType(receiver, index);
  for (let i = 1; i < segments.length - 1 && type; i++) {
    const t = findUserType(symbols, stripGeneric(type));
    const f = t?.fields.find((x) => x.name === segments[i]);
    type = f?.type ?? null;
  }

  if (type) {
    const udt = findUserType(symbols, stripGeneric(type));
    if (udt) {
      const field = udt.fields.find((f) => f.name === member);
      if (field && !preferCall) return { kind: 'user-type-field', type: udt, field };
      const methods = symbols.methods.filter(
        (m) => m.name === member && (!m.receiverType || stripGeneric(m.receiverType) === udt.name),
      );
      if (methods.length) return { kind: 'user-method', name: member, methods, receiverType: type };
      if (field) return { kind: 'user-type-field', type: udt, field };
    }
    const ns = methodNamespace(type);
    if (ns) {
      const fn = index.functions.get(`${ns}.${member}`);
      if (fn) return { kind: 'builtin-method', name: member, fns: [fn], receiverType: type };
    }
  }

  const userMethods = symbols.methods.filter((m) => m.name === member);
  if (userMethods.length) {
    return {
      kind: 'user-method',
      name: member,
      methods: userMethods,
      ...(type ? { receiverType: type } : {}),
    };
  }
  const builtinMethods = index.methodsNamed(member);
  if (builtinMethods.length) {
    return {
      kind: 'builtin-method',
      name: member,
      fns: builtinMethods,
      ...(type ? { receiverType: type } : {}),
    };
  }
  return null;
}

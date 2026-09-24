import { formatOverload, overloadsFor } from './pine-signature';
import type { PineResolved } from './pine-resolve';

/**
 * A hover / completion-info document for a resolved name, as plain data: the editor renders it,
 * tests read it.
 */
export interface PineDocView {
  /** `function`, `variable`, `constant`, `namespace`, `keyword`, `type`, `method`, … */
  kind: string;
  /** Code lines: signatures, `type name`, `name = value`. */
  code: string[];
  doc: string | null;
  /** Extra lines: parameter docs, deprecation, where it is declared. */
  notes: string[];
}

function paramNotes(params: { name: string; type?: string; doc?: string }[]): string[] {
  return params
    .filter((p) => p.doc)
    .map((p) => `${p.name}${p.type ? ` (${p.type})` : ''} — ${p.doc}`);
}

/** The document for a resolved name. `text` is the name as written (for method receivers). */
export function docViewFor(resolved: PineResolved, text: string): PineDocView {
  switch (resolved.kind) {
    case 'builtin-function':
    case 'builtin-method':
    case 'user-function':
    case 'user-method':
    case 'library-export': {
      const { overloads, doc } = overloadsFor(resolved, text);
      const kind =
        resolved.kind === 'builtin-method' || resolved.kind === 'user-method'
          ? 'method'
          : resolved.kind === 'library-export'
            ? `library ${resolved.exported.kind}`
            : 'function';
      const notes: string[] = [];
      if (resolved.kind === 'builtin-function' && resolved.fn.deprecated) notes.push('Deprecated.');
      if (overloads.length === 1) notes.push(...paramNotes(overloads[0].params));
      if (resolved.kind === 'user-function' && resolved.fn.returnsDoc) {
        notes.push(`Returns — ${resolved.fn.returnsDoc}`);
      }
      if (resolved.kind === 'user-function' || resolved.kind === 'user-method') {
        const line = resolved.kind === 'user-function' ? resolved.fn.line : resolved.methods[0].line;
        notes.push(`Declared on line ${line + 1}.`);
      }
      if (resolved.kind === 'library-export') {
        notes.push(`From ${resolved.imp.publisher}/${resolved.imp.libraryName}/${resolved.imp.version}.`);
      }
      const code = overloads.length
        ? overloads.map(formatOverload)
        : resolved.kind === 'library-export' && resolved.exported.signature
          ? [resolved.exported.signature]
          : [text];
      return { kind, code, doc, notes };
    }
    case 'builtin-variable':
      return {
        kind: 'variable',
        code: [`${resolved.path}${resolved.variable.type ? ` : ${resolved.variable.type}` : ''}`],
        doc: resolved.variable.doc ?? null,
        notes: [],
      };
    case 'builtin-constant':
      return {
        kind: 'constant',
        code: [
          `${resolved.path}${resolved.constant.type ? ` : ${resolved.constant.type}` : ''}${
            resolved.constant.valueText ? ` = ${resolved.constant.valueText}` : ''
          }`,
        ],
        doc: resolved.constant.doc ?? null,
        notes: [],
      };
    case 'namespace':
      return { kind: 'namespace', code: [`${resolved.path}.*`], doc: null, notes: [] };
    case 'keyword':
      return { kind: 'keyword', code: [resolved.name], doc: resolved.doc, notes: [] };
    case 'type-keyword':
      return { kind: 'type', code: [resolved.name], doc: resolved.doc, notes: [] };
    case 'user-variable': {
      const v = resolved.variable;
      const decl = [v.declKeyword, v.qualifier, resolved.type, v.name].filter(Boolean).join(' ');
      const where =
        v.role === 'param'
          ? 'Function parameter.'
          : v.role === 'loop'
            ? 'Loop variable.'
            : `Declared on line ${v.line + 1}${v.indent > 0 ? ' (local)' : ''}.`;
      return {
        kind: v.role === 'param' ? 'parameter' : 'variable',
        code: [v.initText && v.role === undefined ? `${decl} = ${v.initText}` : decl],
        doc: v.doc ?? null,
        notes: [where],
      };
    }
    case 'user-type': {
      const t = resolved.type;
      if (resolved.constructor) {
        const { overloads } = overloadsFor(resolved, text);
        return {
          kind: 'constructor',
          code: overloads.map(formatOverload),
          doc: t.doc ?? null,
          notes: [],
        };
      }
      return {
        kind: 'type',
        code: [
          `type ${t.name}`,
          ...t.fields.map(
            (f) => `    ${f.varip ? 'varip ' : ''}${f.type ?? ''} ${f.name}${f.defaultText ? ` = ${f.defaultText}` : ''}`,
          ),
        ],
        doc: t.doc ?? null,
        notes: [`Declared on line ${t.line + 1}.`],
      };
    }
    case 'user-type-field':
      return {
        kind: 'field',
        code: [`${resolved.field.type ?? ''} ${resolved.type.name}.${resolved.field.name}`.trim()],
        doc: resolved.field.doc ?? null,
        notes: [],
      };
    case 'user-enum':
      return {
        kind: 'enum',
        code: [
          `enum ${resolved.enumSymbol.name}`,
          ...resolved.enumSymbol.members.map((m) => `    ${m.name}${m.title ? ` = "${m.title}"` : ''}`),
        ],
        doc: resolved.enumSymbol.doc ?? null,
        notes: [],
      };
    case 'user-enum-member':
      return {
        kind: 'enum member',
        code: [
          `${resolved.enumSymbol.name}.${resolved.member.name}${
            resolved.member.title ? ` = "${resolved.member.title}"` : ''
          }`,
        ],
        doc: resolved.member.doc ?? null,
        notes: [],
      };
    case 'import': {
      const lib = resolved.library;
      return {
        kind: 'library',
        code: [
          `import ${resolved.imp.publisher}/${resolved.imp.libraryName}/${resolved.imp.version} as ${resolved.imp.alias}`,
        ],
        doc: lib?.description ?? null,
        notes: lib?.exports?.length
          ? [`Exports: ${lib.exports.map((e) => e.name).join(', ')}`]
          : lib
            ? []
            : ['Library not found in the libraries list.'],
      };
    }
  }
}

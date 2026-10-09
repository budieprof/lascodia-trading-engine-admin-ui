import type {
  ScriptOutlineItem,
  ScriptRenameEdit,
  ScriptSemantic,
  ScriptSymbol,
} from '@core/api/scripting.types';
import type { PineDocView } from './pine-docs';

/**
 * The engine's semantic model of a compile (PR-I8, scripting API §2a) as the editor reads it:
 * what the name at a position is, where it is declared, every place it is used, and the outline.
 * Offsets are those of the source the model was compiled from — callers use it only while the
 * editor shows exactly that source.
 */

export const REFERENCE_KINDS = [
  'declaration',
  'read',
  'write',
  'call',
  'namedArgument',
  'type',
  'member',
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface SemanticReference {
  symbol: ScriptSymbol;
  from: number;
  to: number;
  kind: ReferenceKind;
}

export class SemanticIndex {
  private readonly refs: SemanticReference[];

  constructor(readonly model: ScriptSemantic) {
    this.refs = model.references
      .filter(([s]) => s >= 0 && s < model.symbols.length)
      .map(([s, offset, length, kind]) => ({
        symbol: model.symbols[s],
        from: offset,
        to: offset + length,
        kind: REFERENCE_KINDS[kind] ?? 'read',
      }))
      .sort((a, b) => a.from - b.from);
  }

  /** The reference covering `pos` (its start up to and including its end), or null. */
  referenceAt(pos: number): SemanticReference | null {
    let lo = 0;
    let hi = this.refs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.refs[mid];
      if (pos < r.from) hi = mid - 1;
      else if (pos > r.to) lo = mid + 1;
      else return r;
    }
    return null;
  }

  /** Every reference of a symbol, in source order. */
  referencesOf(symbol: ScriptSymbol): SemanticReference[] {
    return this.refs.filter((r) => r.symbol.id === symbol.id);
  }

  /** Where the name at `pos` is declared: an offset range in this source, or a library's line. */
  definitionAt(pos: number): Definition | null {
    const r = this.referenceAt(pos);
    if (!r) return null;
    const d = r.symbol.declaration;
    return d.unit
      ? { kind: 'library', unit: d.unit, line: d.line, column: d.column, symbol: r.symbol }
      : { kind: 'local', from: d.offset, to: d.offset + d.length, symbol: r.symbol };
  }
}

export type Definition =
  | { kind: 'local'; from: number; to: number; symbol: ScriptSymbol }
  | { kind: 'library'; unit: string; line: number; column: number; symbol: ScriptSymbol };

const KIND_LABELS: Record<string, string> = {
  variable: 'variable',
  parameter: 'parameter',
  loopVariable: 'loop variable',
  function: 'function',
  method: 'method',
  type: 'type',
  field: 'field',
  enum: 'enum',
  enumMember: 'enum member',
  import: 'library',
};

/** The hover for a user symbol: its kind, type or signature, documentation and where it is declared. */
export function symbolDocView(s: ScriptSymbol): PineDocView {
  const code: string[] = [];
  if (s.kind === 'function' || s.kind === 'method') {
    code.push(s.detail ?? `${s.name}()`);
    if (s.type) code.push(`→ ${s.type}`);
  } else if (s.kind === 'type' || s.kind === 'enum') {
    code.push(s.detail ?? s.name);
  } else if (s.kind === 'import') {
    code.push(`import ${s.detail ?? ''} as ${s.name}`.trim());
  } else {
    code.push([s.detail, s.type, s.name].filter(Boolean).join(' '));
  }
  const notes: string[] = [];
  if (s.container) notes.push(`In \`${s.container}\`.`);
  notes.push(
    s.declaration.unit
      ? `Declared in library ${s.declaration.unit}, line ${s.declaration.line}.`
      : `Declared on line ${s.declaration.line}.`,
  );
  return { kind: KIND_LABELS[s.kind] ?? s.kind, code, doc: s.doc ?? null, notes };
}

/** The outline flattened with each entry's depth (for a plain list). */
export function flattenOutline(
  items: readonly ScriptOutlineItem[],
  depth = 0,
): { item: ScriptOutlineItem; depth: number }[] {
  return items.flatMap((item) => [
    { item, depth },
    ...flattenOutline(item.children ?? [], depth + 1),
  ]);
}

/** A rename's edits applied to `source` (they were planned on exactly this text). */
export function applyRename(source: string, edits: readonly ScriptRenameEdit[]): string {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.offset - a.offset))
    out = out.slice(0, e.offset) + e.text + out.slice(e.offset + e.length);
  return out;
}

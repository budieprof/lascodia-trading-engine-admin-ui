import type {
  PineCatalog,
  PineCatalogConstant,
  PineCatalogFunction,
  PineCatalogNamedDoc,
  PineCatalogVariable,
} from '@core/api/scripting.types';
import { PINE_KEYWORDS, PINE_NAMESPACES, PINE_TYPES } from './pine-lexicon';

export type PineMemberKind = 'function' | 'variable' | 'constant' | 'namespace';

/** One name reachable from a namespace (`ta` → `ema`), or from the top level. */
export interface PineMember {
  /** The member's own segment: `ema`. */
  name: string;
  /** Full dotted path: `ta.ema`. */
  path: string;
  kind: PineMemberKind;
}

export type PineLookup =
  | { kind: 'function'; fn: PineCatalogFunction }
  | { kind: 'variable'; variable: PineCatalogVariable }
  | { kind: 'constant'; constant: PineCatalogConstant }
  | { kind: 'namespace'; name: string };

/** `array.new<type>` → `array.new`. */
export function stripGeneric(name: string): string {
  const i = name.indexOf('<');
  return i >= 0 ? name.slice(0, i) : name;
}

/**
 * Lookup tables over the language catalog: names by kind, namespace membership, and the methods
 * callable with dot syntax. Built from the live catalog, or from name lists alone (the offline
 * fallback: highlighting and name completion work, docs and signatures do not).
 */
export class PineCatalogIndex {
  readonly functions = new Map<string, PineCatalogFunction>();
  readonly variables = new Map<string, PineCatalogVariable>();
  readonly constants = new Map<string, PineCatalogConstant>();
  readonly namespaces = new Set<string>(PINE_NAMESPACES);
  readonly types = new Map<string, PineCatalogNamedDoc>();
  readonly keywords: readonly string[];
  readonly annotations: readonly PineCatalogNamedDoc[];
  private readonly members = new Map<string, PineMember[]>();
  private readonly methodsByName = new Map<string, PineCatalogFunction[]>();

  private constructor(
    readonly version: string | null,
    /** True when built from bare names (no docs or signatures). */
    readonly isFallback: boolean,
    functions: PineCatalogFunction[],
    variables: PineCatalogVariable[],
    constants: PineCatalogConstant[],
    namespaces: readonly string[],
    keywords: readonly string[],
    types: readonly PineCatalogNamedDoc[],
    annotations: readonly PineCatalogNamedDoc[],
  ) {
    for (const f of functions) {
      const name = stripGeneric(f.name);
      const prev = this.functions.get(name);
      // Generic and plain spellings of one function merge their overloads.
      this.functions.set(
        name,
        prev ? { ...prev, overloads: [...prev.overloads, ...f.overloads] } : { ...f, name },
      );
    }
    for (const v of variables) this.variables.set(v.name, v);
    for (const c of constants) this.constants.set(c.name, c);
    for (const ns of namespaces) this.namespaces.add(ns);
    for (const name of [
      ...this.functions.keys(),
      ...this.variables.keys(),
      ...this.constants.keys(),
    ]) {
      const parts = name.split('.');
      for (let i = 1; i < parts.length; i++) this.namespaces.add(parts.slice(0, i).join('.'));
    }
    this.keywords = keywords.length ? keywords : PINE_KEYWORDS;
    for (const t of types.length ? types : PINE_TYPES.map((name) => ({ name }))) {
      this.types.set(t.name, t);
    }
    this.annotations = annotations;
    this.buildMembers();
  }

  static fromCatalog(catalog: PineCatalog): PineCatalogIndex {
    return new PineCatalogIndex(
      catalog.version ?? null,
      false,
      catalog.functions ?? [],
      catalog.variables ?? [],
      catalog.constants ?? [],
      catalog.namespaces ?? [],
      catalog.keywords ?? [],
      catalog.types ?? [],
      catalog.annotations ?? [],
    );
  }

  /** The offline index: names only. */
  static fromNames(
    functions: readonly string[],
    variables: readonly string[],
    constants: readonly string[],
  ): PineCatalogIndex {
    return new PineCatalogIndex(
      null,
      true,
      functions.map((name) => ({ name, overloads: [] })),
      variables.map((name) => ({ name, type: '' })),
      constants.map((name) => ({ name, type: '' })),
      [],
      [],
      [],
      [],
    );
  }

  private buildMembers(): void {
    const add = (ns: string, m: PineMember) => {
      const list = this.members.get(ns);
      if (list) {
        if (!list.some((x) => x.name === m.name && x.kind === m.kind)) list.push(m);
      } else this.members.set(ns, [m]);
    };
    const place = (path: string, kind: PineMemberKind) => {
      const dot = path.lastIndexOf('.');
      add(dot < 0 ? '' : path.slice(0, dot), { name: path.slice(dot + 1), path, kind });
    };
    for (const name of this.functions.keys()) place(name, 'function');
    for (const name of this.variables.keys()) place(name, 'variable');
    for (const name of this.constants.keys()) place(name, 'constant');
    for (const ns of this.namespaces) place(ns, 'namespace');
    for (const fn of this.functions.values()) {
      if (!fn.overloads.some((o) => o.method)) continue;
      const short = fn.name.slice(fn.name.lastIndexOf('.') + 1);
      const list = this.methodsByName.get(short) ?? [];
      list.push(fn);
      this.methodsByName.set(short, list);
    }
  }

  /** Members of a namespace (`''` = the top level: `plot`, `close`, `ta`, …). */
  membersOf(namespace: string): readonly PineMember[] {
    return this.members.get(namespace) ?? [];
  }

  isNamespace(path: string): boolean {
    return this.namespaces.has(path);
  }

  /** Resolves a dotted path to a built-in; functions win over same-named variables. */
  lookup(path: string, preferCall = false): PineLookup | null {
    const name = stripGeneric(path);
    const fn = this.functions.get(name);
    const variable = this.variables.get(name);
    const constant = this.constants.get(name);
    if (fn && (preferCall || (!variable && !constant))) return { kind: 'function', fn };
    if (variable) return { kind: 'variable', variable };
    if (constant) return { kind: 'constant', constant };
    if (fn) return { kind: 'function', fn };
    if (this.namespaces.has(name)) return { kind: 'namespace', name };
    return null;
  }

  /** Built-ins callable as `receiver.name()` (e.g. `push` → `array.push`). */
  methodsNamed(name: string): readonly PineCatalogFunction[] {
    return this.methodsByName.get(name) ?? [];
  }

  /**
   * Methods for a receiver type: `array<float>` → the `array.*` functions flagged as methods;
   * `line` → `line.*`. Falls back to every function of the namespace when the catalog carries no
   * method flags (the offline index).
   */
  methodsForType(type: string): PineCatalogFunction[] {
    const base = stripGeneric(type.trim()).replace(/\[\]$/, '');
    const ns = base === 'string' ? 'str' : base;
    const out: PineCatalogFunction[] = [];
    for (const m of this.membersOf(ns)) {
      if (m.kind !== 'function') continue;
      const fn = this.functions.get(m.path);
      if (!fn) continue;
      if (this.isFallback || fn.overloads.some((o) => o.method)) out.push(fn);
    }
    return out;
  }

  /** The (first overload's) return type of a function, e.g. `series float`. */
  returnTypeOf(path: string): string | null {
    const fn = this.functions.get(stripGeneric(path));
    return fn?.overloads[0]?.returns ?? null;
  }
}

/** `series float` → `float`; `array<float>` stays; `series int/float` → `float`. */
export function baseType(qualified: string | null | undefined): string | null {
  if (!qualified) return null;
  let t = qualified.trim().replace(/^(?:const|input|simple|series)\s+/, '');
  if (t.includes('/')) t = t.split('/').pop() ?? t;
  return t || null;
}
